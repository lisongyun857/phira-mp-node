import { log } from './logger.js';

export const ROOM_MAX_USERS = 8;

/**
 * 房间内部状态：
 * - SelectChart：等待房主选谱
 * - WaitForReady：等待所有玩家/旁观者准备
 * - Playing：游戏中，收集成绩或中止
 */
function initialState() {
  return { kind: 'SelectChart', started: new Set(), results: new Map(), aborted: new Set() };
}

export class Room {
  constructor(id, host) {
    this.id = id;
    this.host = host;
    this.state = initialState();

    this.live = false;
    this.locked = false;
    this.cycle = false;

    this.users = host ? [host] : [];
    this.monitors = [];
    this.chart = null;
  }

  /** 无房主的房间（控制台创建）在第一个玩家加入时认领房主。 */
  claimHost(user) {
    if (this.host) return false;
    this.host = user;
    user.trySend({ type: 'ChangeHost', host: true });
    return true;
  }

  /** 广播给客户端的状态 */
  toClientState() {
    switch (this.state.kind) {
      case 'SelectChart':
        return { kind: 'SelectChart', chart: this.chart ? this.chart.id : null };
      case 'WaitForReady':
        return { kind: 'WaitForReady' };
      default:
        return { kind: 'Playing' };
    }
  }

  clientState(user) {
    const users = new Map();
    for (const it of [...this.users, ...this.monitors]) {
      users.set(it.id, it.toInfo());
    }
    let isReady = false;
    if (this.state.kind === 'WaitForReady') {
      isReady = this.state.started.has(user.id);
    }
    return {
      id: this.id,
      roomState: this.toClientState(),
      live: this.live,
      locked: this.locked,
      cycle: this.cycle,
      isHost: this.host !== null && this.host.id === user.id,
      isReady,
      users,
    };
  }

  addUser(user, monitor) {
    if (monitor) {
      this.monitors.push(user);
      return true;
    }
    if (this.users.length >= ROOM_MAX_USERS) return false;
    this.users.push(user);
    return true;
  }

  checkHost(user) {
    if (!this.host || this.host.id !== user.id) {
      throw new Error('only host can do this');
    }
  }

  sendMessage(message) {
    this.broadcast({ type: 'Message', message });
  }

  broadcast(cmd) {
    for (const user of [...this.users, ...this.monitors]) {
      user.trySend(cmd);
    }
  }

  broadcastMonitors(cmd) {
    for (const user of this.monitors) {
      user.trySend(cmd);
    }
  }

  onStateChange() {
    this.broadcast({ type: 'ChangeState', state: this.toClientState() });
  }

  resetGameTime() {
    for (const user of this.users) {
      user.gameTime = -Infinity;
    }
  }

  /** 返回房间是否应被销毁。 */
  onUserLeave(user) {
    this.sendMessage({ type: 'LeaveRoom', user: user.id, name: user.name });

    user.room = null;
    const list = user.monitor ? this.monitors : this.users;
    const index = list.findIndex((it) => it.id === user.id);
    if (index >= 0) list.splice(index, 1);

    if (this.users.length === 0) {
      log.info('room users all disconnected, dropping room');
      return true;
    }

    if (this.host && this.host.id === user.id) {
      log.info('host disconnected!');
      const newHost = this.users[Math.floor(Math.random() * this.users.length)];
      log.debug(`selected ${newHost.id} as host`);
      this.host = newHost;
      this.sendMessage({ type: 'NewHost', user: newHost.id });
      newHost.trySend({ type: 'ChangeHost', host: true });
    }

    this.checkAllReady();
    return false;
  }

  checkAllReady() {
    if (this.state.kind === 'WaitForReady') {
      const everyone = [...this.users, ...this.monitors];
      if (everyone.every((it) => this.state.started.has(it.id))) {
        log.info(`room ${this.id}: game start`);
        this.sendMessage({ type: 'StartPlaying' });
        this.resetGameTime();
        this.state = { kind: 'Playing', started: new Set(), results: new Map(), aborted: new Set() };
        this.onStateChange();
      }
      return;
    }

    if (this.state.kind === 'Playing') {
      const { results, aborted } = this.state;
      if (this.users.every((it) => results.has(it.id) || aborted.has(it.id))) {
        this.sendMessage({ type: 'GameEnd' });
        const previousHost = this.host;
        this.state = initialState();

        if (this.cycle && this.users.length > 0) {
          log.debug(`room ${this.id}: cycling`);
          let index = this.users.findIndex(
            (it) => previousHost !== null && it.id === previousHost.id,
          );
          index = index >= 0 ? (index + 1) % this.users.length : 0;
          const newHost = this.users[index];
          this.host = newHost;
          this.sendMessage({ type: 'NewHost', user: newHost.id });
          if (previousHost) previousHost.trySend({ type: 'ChangeHost', host: false });
          newHost.trySend({ type: 'ChangeHost', host: true });
        }

        this.onStateChange();
      }
    }
  }
}
