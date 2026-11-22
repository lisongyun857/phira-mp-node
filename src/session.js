import { decodeClientCommand, encodeServerCommand, ok, err } from './protocol/models.js';
import { User } from './user.js';
import { Room } from './room.js';
import { buildLobbyMessages } from './lobby.js';
import { normalizeLang, t } from './l10n.js';
import { log } from './logger.js';

const HOST = 'https://phira.5wyxi.com';
const MAX_PACKET_SIZE = 2 * 1024 * 1024;
const HEARTBEAT_DISCONNECT_TIMEOUT = 10_000;

function encodeUleb(value) {
  const bytes = [];
  let n = value;
  do {
    let byte = n & 0x7f;
    n = Math.floor(n / 128);
    if (n !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (n !== 0);
  return Buffer.from(bytes);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`request failed with status ${res.status}`);
  return res.json();
}

async function fetchChart(id) {
  const url = `${HOST}/chart/${id}`;
  const res = await fetch(url);
  if (!res.ok) {
    log.warn(`chart ${id} fetch failed: HTTP ${res.status} (${url})`);
    throw new Error(`chart ${id} unavailable on Phira (HTTP ${res.status})`);
  }
  const chart = await res.json();
  log.debug(`chart ${id} -> ${chart.name}`);
  return chart;
}

function requireRoom(user) {
  if (!user.room) throw new Error('no room');
  return user.room;
}

function requireRoomState(user, kind) {
  const room = requireRoom(user);
  if (room.state.kind !== kind) throw new Error('invalid state');
  return room;
}

async function attempt(fn) {
  try {
    return ok(await fn());
  } catch (e) {
    return err(e && e.message ? e.message : String(e));
  }
}

export class Session {
  constructor(id, socket, server) {
    this.id = id;
    this.socket = socket;
    this.server = server;

    this.user = null;
    this.version = 0;
    this.gotVersion = false;
    this.waitingForAuth = true;
    this.panicked = false;
    this.lost = false;

    this.lastRecv = Date.now();
    this.buffer = Buffer.alloc(0);
    /** 串行处理包，保证同一会话内命令顺序执行 */
    this.queue = Promise.resolve();

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (e) => log.warn(`session ${this.id} socket error: ${e.message}`));
    socket.on('close', () => log.debug(`session ${this.id} socket closed`));

    // 与 Rust 版本一致：超过 10 秒没有收到任何数据则判定掉线
    this.heartbeatTimer = setInterval(() => this.checkHeartbeat(), 1000);
  }

  send(cmd) {
    if (this.lost || this.socket.destroyed) return;
    try {
      const payload = encodeServerCommand(cmd);
      const header = encodeUleb(payload.length);
      this.socket.write(Buffer.concat([header, payload]));
    } catch (e) {
      log.error(`failed to send ${cmd.type} to ${this.id}: ${e.message}`);
    }
  }

  onData(chunk) {
    if (this.lost) return;
    this.lastRecv = Date.now();
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    if (!this.gotVersion) {
      if (this.buffer.length < 1) return;
      this.version = this.buffer[0];
      this.buffer = this.buffer.subarray(1);
      this.gotVersion = true;
      log.info(`session ${this.id} version ${this.version}`);
    }

    for (;;) {
      let length = 0;
      let shift = 0;
      let index = 0;
      let byte;
      for (;;) {
        if (index >= this.buffer.length) return;
        byte = this.buffer[index];
        index += 1;
        length += (byte & 0x7f) * 2 ** shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
        if (shift > 32) {
          log.warn(`session ${this.id}: invalid length`);
          this.failConnection();
          return;
        }
      }

      if (length > MAX_PACKET_SIZE) {
        log.warn(`session ${this.id}: data packet too large`);
        this.failConnection();
        return;
      }
      if (this.buffer.length < index + length) return;

      const payload = Buffer.from(this.buffer.subarray(index, index + length));
      this.buffer = this.buffer.subarray(index + length);

      this.queue = this.queue
        .then(() => this.handlePacket(payload))
        .catch((e) => log.error(`session ${this.id} handler error: ${e.stack || e}`));
    }
  }

  async handlePacket(payload) {
    this.lastRecv = Date.now();
    if (this.panicked) return;

    let cmd;
    try {
      cmd = decodeClientCommand(payload);
    } catch (e) {
      log.warn(`session ${this.id}: invalid packet: ${e.message}`);
      this.failConnection();
      return;
    }

    if (cmd.type === 'Ping') {
      this.send({ type: 'Pong' });
      return;
    }

    if (this.waitingForAuth) {
      if (cmd.type !== 'Authenticate') {
        log.warn(`packet before authentication, ignoring: ${cmd.type}`);
        return;
      }
      await this.authenticate(cmd.token);
      return;
    }

    if (!this.user) return;
    const resp = await processCommand(this.user, cmd);
    if (resp) this.send(resp);
  }

  async authenticate(token) {
    log.debug(`session ${this.id}: authenticate ${token}`);

    let info;
    try {
      const res = await fetch(`${HOST}/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      info = await res.json();
    } catch (e) {
      log.warn(`failed to fetch info: ${e.message}`);
      this.send({ type: 'Authenticate', result: err('failed to fetch info') });
      this.closeAfterFlush();
      return;
    }

    log.debug(`session ${this.id} <- ${JSON.stringify(info)}`);

    const lang = normalizeLang(info.language);
    let user = this.server.users.get(info.id);
    if (user) {
      log.info('reconnect');
      user.setSession(this);
    } else {
      user = new User(info.id, String(info.name), lang, this.server);
      user.setSession(this);
      this.server.users.set(info.id, user);
    }
    this.user = user;

    const roomState = user.room ? user.room.clientState(user) : null;
    this.send({
      type: 'Authenticate',
      result: ok([user.toInfo(), roomState]),
    });
    this.waitingForAuth = false;

    // 新连接（非断线重连回房间）时展示公告与在线房间
    if (!user.room) {
      const messages = buildLobbyMessages(this.server);
      for (const content of messages) {
        this.send({ type: 'Message', message: { type: 'Chat', user: 0, content } });
      }
      log.info(`user ${user.id} connected, sent ${messages.length} lobby message(s)`);
    }
  }

  /** 非法数据：停止处理，等待心跳超时后的掉线流程 */
  failConnection() {
    this.panicked = true;
    this.socket.destroy();
  }

  /** 发送完当前数据后立即断开（鉴权失败） */
  closeAfterFlush() {
    this.panicked = true;
    this.socket.end(() => this.markLost());
    setTimeout(() => this.markLost(), 3000).unref();
  }

  checkHeartbeat() {
    if (this.lost) return;
    if (Date.now() - this.lastRecv > HEARTBEAT_DISCONNECT_TIMEOUT) {
      this.markLost();
    }
  }

  markLost() {
    if (this.lost) return;
    this.lost = true;
    clearInterval(this.heartbeatTimer);
    log.warn(`lost connection with ${this.id}`);

    this.socket.destroy();

    if (this.server.sessions.get(this.id) === this) {
      this.server.sessions.delete(this.id);
    }
    if (this.user && this.user.session === this) {
      this.user.dangle();
    }
  }
}

async function processCommand(user, cmd) {
  switch (cmd.type) {
    case 'Ping':
      return null;

    case 'Authenticate':
      return { type: 'Authenticate', result: err('repeated authenticate') };

    case 'Chat':
      return {
        type: 'Chat',
        result: await attempt(async () => {
          const room = requireRoom(user);
          log.info(`chat ${room.id} ${user.id}(${user.name}): ${cmd.message}`);
          room.sendMessage({ type: 'Chat', user: user.id, content: cmd.message });
        }),
      };

    case 'Touches': {
      const room = user.room;
      if (!room) {
        log.warn('no room');
        return null;
      }
      if (!room.live) {
        log.warn('received touch events in non-live mode');
        return null;
      }
      log.debug(`received ${cmd.frames.length} touch events from ${user.id}`);
      if (cmd.frames.length > 0) {
        user.gameTime = cmd.frames[cmd.frames.length - 1].time;
      }
      room.broadcastMonitors({ type: 'Touches', player: user.id, frames: cmd.frames });
      return null;
    }

    case 'Judges': {
      const room = user.room;
      if (!room) {
        log.warn('no room');
        return null;
      }
      if (!room.live) {
        log.warn('received judge events in non-live mode');
        return null;
      }
      log.debug(`received ${cmd.judges.length} judge events from ${user.id}`);
      room.broadcastMonitors({ type: 'Judges', player: user.id, judges: cmd.judges });
      return null;
    }

    case 'CreateRoom':
      return {
        type: 'CreateRoom',
        result: await attempt(async () => {
          if (user.room) throw new Error('already in room');
          if (user.server.rooms.has(cmd.id)) {
            throw new Error(t(user.lang, 'create-id-occupied'));
          }
          const room = new Room(cmd.id, user);
          user.server.rooms.set(cmd.id, room);
          room.sendMessage({ type: 'CreateRoom', user: user.id });
          user.room = room;
          const hidden = cmd.id.startsWith('_') ? ' (hidden)' : '';
          log.info(`user ${user.id} create room ${cmd.id}${hidden}`);
        }),
      };

    case 'JoinRoom':
      return {
        type: 'JoinRoom',
        result: await attempt(async () => {
          if (user.room) throw new Error('already in room');
          const room = user.server.rooms.get(cmd.id);
          if (!room) throw new Error('room not found');
          if (room.locked) throw new Error(t(user.lang, 'join-room-locked'));
          if (room.state.kind !== 'SelectChart') {
            throw new Error(t(user.lang, 'join-game-ongoing'));
          }
          if (cmd.monitor && !user.canMonitor()) {
            throw new Error(t(user.lang, 'join-cant-monitor'));
          }
          if (!room.addUser(user, cmd.monitor)) {
            throw new Error(t(user.lang, 'join-room-full'));
          }
          log.info(`user ${user.id} join room ${cmd.id} (monitor: ${cmd.monitor})`);

          user.monitor = cmd.monitor;
          const becameHost = !cmd.monitor && room.claimHost(user);
          if (becameHost) {
            log.info(`user ${user.id} became host of room ${room.id}`);
          }
          if (cmd.monitor && !room.live) {
            room.live = true;
            log.info(`room ${cmd.id} goes live`);
          }
          room.broadcast({ type: 'OnJoinRoom', user: user.toInfo() });
          room.sendMessage({ type: 'JoinRoom', user: user.id, name: user.name });
          user.room = room;
          if (becameHost) {
            // 必须在 JoinRoom 响应之后发送，否则客户端会在入房完成前处理房主变更并超时
            setImmediate(() => {
              if (user.room === room) user.trySend({ type: 'ChangeHost', host: true });
            });
          }

          return {
            state: room.toClientState(),
            users: [...room.users, ...room.monitors].map((it) => it.toInfo()),
            live: room.live,
          };
        }),
      };

    case 'LeaveRoom':
      return {
        type: 'LeaveRoom',
        result: await attempt(async () => {
          // 房间可能已被管理员删除，直接返回成功让客户端退出房间
          const room = user.room;
          if (!room) return;
          log.info(`user ${user.id} leave room ${room.id}`);
          if (room.onUserLeave(user)) {
            user.server.rooms.delete(room.id);
          }
        }),
      };

    case 'LockRoom':
      return {
        type: 'LockRoom',
        result: await attempt(async () => {
          const room = requireRoom(user);
          room.checkHost(user);
          log.info(`user ${user.id} lock room ${room.id}: ${cmd.lock}`);
          room.locked = cmd.lock;
          room.sendMessage({ type: 'LockRoom', lock: cmd.lock });
        }),
      };

    case 'CycleRoom':
      return {
        type: 'CycleRoom',
        result: await attempt(async () => {
          const room = requireRoom(user);
          room.checkHost(user);
          log.info(`user ${user.id} cycle room ${room.id}: ${cmd.cycle}`);
          room.cycle = cmd.cycle;
          room.sendMessage({ type: 'CycleRoom', cycle: cmd.cycle });
        }),
      };

    case 'SelectChart':
      return {
        type: 'SelectChart',
        result: await attempt(async () => {
          const room = requireRoomState(user, 'SelectChart');
          room.checkHost(user);
          log.debug(`room ${room.id}: user ${user.id} select chart ${cmd.id}`);
          const chart = await fetchChart(cmd.id);
          room.sendMessage({
            type: 'SelectChart',
            user: user.id,
            name: chart.name,
            id: chart.id,
          });
          room.chart = { id: chart.id, name: chart.name };
          room.onStateChange();
        }),
      };

    case 'RequestStart':
      return {
        type: 'RequestStart',
        result: await attempt(async () => {
          const room = requireRoomState(user, 'SelectChart');
          room.checkHost(user);
          if (!room.chart) throw new Error(t(user.lang, 'start-no-chart-selected'));
          log.debug(`room ${room.id}: wait for ready`);
          room.resetGameTime();
          room.sendMessage({ type: 'GameStart', user: user.id });
          room.state = {
            kind: 'WaitForReady',
            started: new Set([user.id]),
            results: new Map(),
            aborted: new Set(),
          };
          room.onStateChange();
          room.checkAllReady();
        }),
      };

    case 'Ready':
      return {
        type: 'Ready',
        result: await attempt(async () => {
          const room = requireRoom(user);
          if (room.state.kind === 'WaitForReady') {
            if (room.state.started.has(user.id)) throw new Error('already ready');
            room.state.started.add(user.id);
            room.sendMessage({ type: 'Ready', user: user.id });
            room.checkAllReady();
          }
        }),
      };

    case 'CancelReady':
      return {
        type: 'CancelReady',
        result: await attempt(async () => {
          const room = requireRoom(user);
          if (room.state.kind === 'WaitForReady') {
            if (!room.state.started.delete(user.id)) throw new Error('not ready');
            let isHost = false;
            try {
              room.checkHost(user);
              isHost = true;
            } catch {
              isHost = false;
            }
            if (isHost) {
              room.sendMessage({ type: 'CancelGame', user: user.id });
              room.state = {
                kind: 'SelectChart',
                started: new Set(),
                results: new Map(),
                aborted: new Set(),
              };
              room.onStateChange();
            } else {
              room.sendMessage({ type: 'CancelReady', user: user.id });
            }
          }
        }),
      };

    case 'Played':
      return {
        type: 'Played',
        result: await attempt(async () => {
          const room = requireRoom(user);
          const record = await fetchJson(`${HOST}/record/${cmd.id}`);
          if (record.player !== user.id) throw new Error('invalid record');
          log.debug(`room ${room.id}: user ${user.id} played: ${JSON.stringify(record)}`);
          room.sendMessage({
            type: 'Played',
            user: user.id,
            score: record.score,
            accuracy: record.accuracy,
            fullCombo: record.full_combo === true,
          });

          if (room.state.kind === 'Playing') {
            if (room.state.aborted.has(user.id)) throw new Error('aborted');
            if (room.state.results.has(user.id)) throw new Error('already uploaded');
            room.state.results.set(user.id, record);
            room.checkAllReady();
          }
        }),
      };

    case 'Abort':
      return {
        type: 'Abort',
        result: await attempt(async () => {
          const room = requireRoom(user);
          if (room.state.kind === 'Playing') {
            if (room.state.results.has(user.id)) throw new Error('already uploaded');
            if (room.state.aborted.has(user.id)) throw new Error('aborted');
            room.state.aborted.add(user.id);
            room.sendMessage({ type: 'Abort', user: user.id });
            room.checkAllReady();
          }
        }),
      };

    default:
      return null;
  }
}
