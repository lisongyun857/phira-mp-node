import http from 'node:http';
import { Room, ROOM_MAX_USERS } from './room.js';
import { isValidRoomId } from './protocol/models.js';
import { handleLoginPage, normalizeLoginIdentity } from './login.js';
import { fetchChart } from './session.js';
import { roomStateName } from './lobby.js';
import { log } from './logger.js';

const MAX_BODY_BYTES = 64 * 1024;

const DEFAULT_OPTIONS = {
  enabled: true,
  host: '127.0.0.1',
  port: 3052,
  accessToken: '',
  protectedPaths: [],
  publicPaths: [],
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function ok(res, data = {}) {
  sendJson(res, 200, { ok: true, data });
}

function fail(res, status, error) {
  sendJson(res, status, { ok: false, error });
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

function compilePathPattern(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const match = raw.match(/^([A-Za-z]+)\s+(.+)$/);
  let method = null;
  let pattern = raw;
  if (match && HTTP_METHODS.has(match[1].toUpperCase())) {
    method = match[1].toUpperCase();
    pattern = match[2].trim();
  }
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return { method, regex: new RegExp(`^${escaped}$`) };
}

function compilePathPatterns(list) {
  if (!Array.isArray(list)) return [];
  return list.map(compilePathPattern).filter(Boolean);
}

function matchesPatterns(patterns, method, pathname) {
  return patterns.some(
    (pattern) => (!pattern.method || pattern.method === method) && pattern.regex.test(pathname),
  );
}

function hasToken(req, token) {
  const header = req.headers.authorization || '';
  return header === `Bearer ${token}` || header === token;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid json body'));
      }
    });

    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

function roomToJson(room) {
  return {
    id: room.id,
    hidden: room.id.startsWith('_'),
    users: room.users.length,
    monitors: room.monitors.length,
    maxUsers: ROOM_MAX_USERS,
    chart: room.chart ? { id: room.chart.id, name: room.chart.name } : null,
    locked: Boolean(room.locked),
    live: Boolean(room.live),
    host: room.host ? { id: room.host.id, name: room.host.name } : null,
    state: room.state.kind,
  };
}

/** 带 HTTP 状态码的 API 错误 */
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function roomDetailJson(room, actor) {
  const members = [...room.users, ...room.monitors].map((user) => ({
    id: user.id,
    name: user.name,
    monitor: Boolean(user.monitor),
    online: Boolean(user.session),
  }));
  return {
    id: room.id,
    state: room.state.kind,
    stateName: roomStateName(room),
    host: room.host ? { id: room.host.id, name: room.host.name } : null,
    chart: room.chart ? { id: room.chart.id, name: room.chart.name } : null,
    locked: Boolean(room.locked),
    cycle: Boolean(room.cycle),
    live: Boolean(room.live),
    users: room.users.length,
    monitors: room.monitors.length,
    maxUsers: ROOM_MAX_USERS,
    isHost: Boolean(room.host && room.host.id === actor.id),
    members,
  };
}

/** 通过玩家 ID 或昵称在房间内定位目标 */
function findRoomTarget(room, body, playersOnly) {
  const pool = playersOnly ? room.users : [...room.users, ...room.monitors];

  const rawId = body.targetId;
  if (rawId !== undefined && rawId !== null && rawId !== '') {
    const id = Number(rawId);
    if (!Number.isInteger(id)) throw new ApiError(400, 'targetId 必须是整数');
    const found = pool.find((user) => user.id === id);
    if (!found) throw new ApiError(404, '房间内找不到该玩家');
    return found;
  }

  const name = String(body.targetName ?? '').trim();
  if (!name) throw new ApiError(400, '缺少 targetId 或 targetName');
  const matches = pool.filter((user) => user.name === name);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new ApiError(409, '房间内有多个同名玩家，请改用玩家 ID');
  throw new ApiError(404, '房间内找不到该玩家');
}

/** 解散房间并解除所有成员的房间绑定 */
function dissolveRoom(state, room, notice) {
  const members = [...room.users, ...room.monitors];
  if (members.length > 0) {
    room.sendMessage({ type: 'Chat', user: 0, content: notice });
  }
  for (const member of members) {
    member.room = null;
    member.monitor = false;
    log.info(`API: detached user ${member.id} from deleted room ${room.id}`);
  }
  room.users.length = 0;
  room.monitors.length = 0;
  state.rooms.delete(room.id);
  log.info(`API: deleted room ${room.id} (${members.length} member(s))`);
  return members.length;
}

/**
 * QQ 绑定账号的房间控制。
 * 请求：{ platform, userId, action, roomId?, admin?, ... }
 * 权限：房主本人；admin=true 时（管理员 QQ）可操作任意房间。
 */
async function handleRoomAction(state, body, res) {
  const identity = normalizeLoginIdentity(body.platform, body.userId);
  if (!identity) throw new ApiError(400, 'platform/userId 不合法');
  if (!state.login) throw new ApiError(503, '登录服务未初始化');

  const binding = state.login.getBinding(identity.platform, identity.userId);
  if (!binding) throw new ApiError(403, '该 QQ 尚未绑定 Phira 账号，请先发送 /p登录');

  const actor = state.users.get(binding.phiraId);
  if (!actor) {
    throw new ApiError(403, '绑定的 Phira 账号当前不在线，请先在游戏中登录服务器');
  }

  const action = String(body.action ?? '').trim().toLowerCase();
  if (!action) throw new ApiError(400, '缺少 action');

  const admin = body.admin === true;
  const requestedRoomId = String(body.roomId ?? '').trim();
  let room = actor.room;
  if (requestedRoomId) {
    const requested = state.rooms.get(requestedRoomId);
    if (!requested) throw new ApiError(404, `房间 ${requestedRoomId} 不存在`);
    if (requested !== actor.room && !admin) throw new ApiError(403, '你不在该房间内');
    room = requested;
  }
  if (!room) throw new ApiError(400, '你当前不在任何房间中');

  const isHost = Boolean(room.host && room.host.id === actor.id);
  const isMember = room.users.includes(actor) || room.monitors.includes(actor);

  const requireHost = () => {
    if (!isHost && !admin) throw new ApiError(403, '只有房主可以执行该操作');
  };
  const requireMember = () => {
    if (!isMember) throw new ApiError(403, '你不在该房间内');
  };
  const requireState = (kind, message) => {
    if (room.state.kind !== kind) throw new ApiError(409, message);
  };

  const label = `${identity.platform}:${identity.userId}`;

  switch (action) {
    case 'info': {
      if (!isMember && !admin) throw new ApiError(403, '你不在该房间内');
      ok(res, { room: roomDetailJson(room, actor) });
      return;
    }

    case 'lock': {
      requireHost();
      const locked = body.locked === undefined ? true : body.locked === true;
      room.locked = locked;
      room.sendMessage({ type: 'LockRoom', lock: locked });
      log.info(`API: ${label} set room ${room.id} locked=${locked}`);
      ok(res, { id: room.id, locked });
      return;
    }

    case 'cycle': {
      requireHost();
      const enabled = body.enabled === true;
      room.cycle = enabled;
      room.sendMessage({ type: 'CycleRoom', cycle: enabled });
      log.info(`API: ${label} set room ${room.id} cycle=${enabled}`);
      ok(res, { id: room.id, cycle: enabled });
      return;
    }

    case 'select-chart': {
      requireMember();
      requireHost();
      requireState('SelectChart', '当前不在选谱阶段');
      const chartId = Number(body.chartId);
      if (!Number.isInteger(chartId)) throw new ApiError(400, 'chartId 必须是整数');
      const chart = await fetchChart(chartId);
      room.sendMessage({
        type: 'SelectChart',
        user: actor.id,
        name: chart.name,
        id: chart.id,
      });
      room.chart = { id: chart.id, name: chart.name };
      room.onStateChange();
      log.info(`API: ${label} selected chart ${chart.id} in room ${room.id}`);
      ok(res, { id: room.id, chart: room.chart });
      return;
    }

    case 'start': {
      requireMember();
      requireHost();
      requireState('SelectChart', '当前不在选谱阶段');
      if (!room.chart) throw new ApiError(409, '还没有选择谱面');
      room.resetGameTime();
      room.sendMessage({ type: 'GameStart', user: actor.id });
      room.state = {
        kind: 'WaitForReady',
        started: new Set([actor.id]),
        results: new Map(),
        aborted: new Set(),
      };
      room.onStateChange();
      room.checkAllReady();
      log.info(`API: ${label} started game in room ${room.id}`);
      ok(res, { id: room.id, state: room.state.kind });
      return;
    }

    case 'ready': {
      requireMember();
      requireState('WaitForReady', '当前不在准备阶段');
      if (room.state.started.has(actor.id)) throw new ApiError(409, '你已经准备过了');
      room.state.started.add(actor.id);
      room.sendMessage({ type: 'Ready', user: actor.id });
      room.checkAllReady();
      ok(res, { id: room.id, ready: true });
      return;
    }

    case 'cancel-ready': {
      requireMember();
      requireState('WaitForReady', '当前不在准备阶段');
      if (!room.state.started.delete(actor.id)) throw new ApiError(409, '你还没有准备');
      if (isHost) {
        room.sendMessage({ type: 'CancelGame', user: actor.id });
        room.state = {
          kind: 'SelectChart',
          started: new Set(),
          results: new Map(),
          aborted: new Set(),
        };
        room.onStateChange();
      } else {
        room.sendMessage({ type: 'CancelReady', user: actor.id });
      }
      ok(res, { id: room.id, ready: false });
      return;
    }

    case 'abort': {
      requireMember();
      requireState('Playing', '当前不在游戏中');
      if (room.state.results.has(actor.id)) throw new ApiError(409, '你已经上传过成绩');
      if (room.state.aborted.has(actor.id)) throw new ApiError(409, '你已经中止过了');
      room.state.aborted.add(actor.id);
      room.sendMessage({ type: 'Abort', user: actor.id });
      room.checkAllReady();
      ok(res, { id: room.id, aborted: true });
      return;
    }

    case 'kick': {
      requireHost();
      const target = findRoomTarget(room, body, false);
      if (target.id === actor.id) throw new ApiError(400, '不能踢出自己');
      const info = { id: target.id, name: target.name };
      target.trySend({
        type: 'Message',
        message: { type: 'Chat', user: 0, content: '你已被移出房间' },
      });
      const destroyed = room.onUserLeave(target);
      if (destroyed) state.rooms.delete(room.id);
      log.info(`API: ${label} kicked ${target.id} from room ${room.id}`);
      ok(res, { id: room.id, target: info, roomDeleted: destroyed });
      return;
    }

    case 'set-host': {
      requireHost();
      const target = findRoomTarget(room, body, true);
      if (target.id === actor.id) throw new ApiError(409, '你已经是房主');
      const previous = room.host;
      room.host = target;
      room.sendMessage({ type: 'NewHost', user: target.id });
      if (previous) previous.trySend({ type: 'ChangeHost', host: false });
      target.trySend({ type: 'ChangeHost', host: true });
      log.info(`API: ${label} transferred room ${room.id} to ${target.id}`);
      ok(res, { id: room.id, host: { id: target.id, name: target.name } });
      return;
    }

    case 'dissolve': {
      requireHost();
      const targetId = room.id;
      const members = dissolveRoom(
        state,
        room,
        admin && !isHost ? '【管理】房间已被管理员解散' : '房间已被房主解散',
      );
      log.info(`API: ${label} dissolved room ${targetId}`);
      ok(res, { id: targetId, members });
      return;
    }

    default:
      throw new ApiError(400, `未知房间操作：${action}`);
  }
}

async function handleRequest(state, req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  const method = req.method || 'GET';

  if (method === 'GET' && pathname === '/api/status') {
    ok(res, {
      uptime: Math.floor(process.uptime()),
      users: state.users.size,
      sessions: state.sessions.size,
      rooms: state.rooms.size,
      allowClientCreateRoom: Boolean(state.allowClientCreateRoom),
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/login/link') {
    const body = await readJson(req);
    const identity = normalizeLoginIdentity(body.platform, body.userId);
    if (!identity) {
      fail(res, 400, 'platform/userId 不合法');
      return;
    }
    if (!state.login) {
      fail(res, 503, '登录服务未初始化');
      return;
    }
    const created = state.login.createSession(identity.platform, identity.userId);
    if (!created.ok) {
      fail(res, created.error === '登录功能未启用' ? 403 : 400, created.error);
      return;
    }
    ok(res, {
      link: created.link,
      expiresAt: new Date(created.expiresAt).toISOString(),
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/login/binding') {
    const identity = normalizeLoginIdentity(
      url.searchParams.get('platform'),
      url.searchParams.get('userId'),
    );
    if (!identity) {
      fail(res, 400, 'platform/userId 不合法');
      return;
    }
    if (!state.login) {
      fail(res, 503, '登录服务未初始化');
      return;
    }
    const binding = state.login.getBinding(identity.platform, identity.userId);
    ok(res, binding ? { bound: true, binding } : { bound: false });
    return;
  }

  if (method === 'DELETE' && pathname === '/api/login/binding') {
    const body = await readJson(req);
    const identity = normalizeLoginIdentity(body.platform, body.userId);
    if (!identity) {
      fail(res, 400, 'platform/userId 不合法');
      return;
    }
    if (!state.login) {
      fail(res, 503, '登录服务未初始化');
      return;
    }
    const removed = state.login.unbind(identity.platform, identity.userId);
    log.info(
      `API: ${removed ? 'unbound' : 'no binding for'} ${identity.platform}:${identity.userId}`,
    );
    ok(res, { unbound: removed });
    return;
  }

  if (method === 'POST' && pathname === '/api/room-creation') {
    const body = await readJson(req);
    if (typeof body.enabled !== 'boolean') {
      fail(res, 400, 'enabled 必须是布尔值');
      return;
    }
    state.allowClientCreateRoom = body.enabled;
    log.info(
      `API: client room creation ${state.allowClientCreateRoom ? 'enabled' : 'disabled'}`,
    );
    ok(res, { enabled: state.allowClientCreateRoom });
    return;
  }

  if (method === 'POST' && pathname === '/api/room/action') {
    const body = await readJson(req);
    await handleRoomAction(state, body, res);
    return;
  }

  if (method === 'GET' && pathname === '/api/rooms') {
    const all = url.searchParams.get('all');
    const includeHidden = all === '1' || all === 'true';
    const rooms = [...state.rooms.values()]
      .filter((room) => includeHidden || !room.id.startsWith('_'))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(roomToJson);
    ok(res, { rooms });
    return;
  }

  if (method === 'POST' && pathname === '/api/rooms/create') {
    const body = await readJson(req);
    const id = String(body.id ?? '').trim();
    if (!id) {
      fail(res, 400, '缺少房间 ID');
      return;
    }
    if (!isValidRoomId(id)) {
      fail(res, 400, '房间 ID 只能包含字母、数字、-、_，长度 1~20');
      return;
    }
    if (state.rooms.has(id)) {
      fail(res, 409, `房间 ${id} 已存在`);
      return;
    }
    const room = new Room(id, null);
    state.rooms.set(id, room);
    log.info(`API: created room ${id}`);
    ok(res, { room: roomToJson(room) });
    return;
  }

  if (method === 'POST' && pathname === '/api/rooms/delete') {
    const body = await readJson(req);
    const id = String(body.id ?? '').trim();
    if (!id) {
      fail(res, 400, '缺少房间 ID');
      return;
    }
    const room = state.rooms.get(id);
    if (!room) {
      fail(res, 404, `房间 ${id} 不存在`);
      return;
    }

    const members = dissolveRoom(state, room, '【管理】房间已被管理员解散');
    ok(res, { id, members });
    return;
  }

  if (method === 'POST' && pathname === '/api/say') {
    const body = await readJson(req);
    const target = String(body.target ?? '').trim();
    const content = String(body.content ?? '').trim();
    if (!target || !content) {
      fail(res, 400, '用法：<房间ID|all> <内容>');
      return;
    }

    if (target === 'all') {
      for (const room of state.rooms.values()) {
        room.sendMessage({ type: 'Chat', user: 0, content: `【管理】${content}` });
      }
      log.info(`API: broadcast to ${state.rooms.size} room(s)`);
      ok(res, { target, rooms: state.rooms.size });
      return;
    }

    const room = state.rooms.get(target);
    if (!room) {
      fail(res, 404, `房间 ${target} 不存在`);
      return;
    }
    room.sendMessage({ type: 'Chat', user: 0, content: `【管理】${content}` });
    log.info(`API: message to room ${target}`);
    ok(res, { target, rooms: 1 });
    return;
  }

  if (method === 'POST' && pathname === '/api/announce') {
    const body = await readJson(req);
    const content = String(body.content ?? '').trim();
    if (!content) {
      fail(res, 400, '缺少公告内容');
      return;
    }

    for (const user of state.users.values()) {
      user.trySend({
        type: 'Message',
        message: { type: 'Chat', user: 0, content: `【公告】${content}` },
      });
    }
    log.info(`API: announced to ${state.users.size} user(s)`);
    ok(res, { users: state.users.size });
    return;
  }

  fail(res, 404, 'not found');
}

export function startApi(state) {
  const config = { ...DEFAULT_OPTIONS, ...(state.config.api || {}) };
  if (!config.enabled) {
    log.info('HTTP API disabled');
    return null;
  }

  const protectedPatterns = compilePathPatterns(config.protectedPaths);
  const publicPatterns = compilePathPatterns(config.publicPaths);

  /** 默认全部公开；只有匹配 protected_paths（且未被 public_paths 覆盖）的接口才校验 token */
  const requiresToken = (method, pathname) => {
    if (!config.accessToken) return false;
    if (matchesPatterns(publicPatterns, method, pathname)) return false;
    return matchesPatterns(protectedPatterns, method, pathname);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/login' || url.pathname.startsWith('/login/')) {
      handleLoginPage(state, req, res, url).catch((e) => {
        log.error(`login: unhandled error: ${e.stack || e.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('internal server error');
        }
      });
      return;
    }
    const method = req.method || 'GET';
    if (requiresToken(method, url.pathname) && !hasToken(req, config.accessToken)) {
      fail(res, 401, 'unauthorized');
      return;
    }
    handleRequest(state, req, res).catch((e) => {
      log.warn(`API: ${req.method} ${req.url} failed: ${e.message}`);
      if (!res.headersSent) fail(res, e.status || 400, e.message);
    });
  });

  server.listen(config.port, config.host, () => {
    log.info(`HTTP API listening on http://${config.host}:${config.port}`);
    if (!config.accessToken) {
      log.warn('HTTP API: access_token is empty, all endpoints are public');
    } else if (protectedPatterns.length === 0) {
      log.warn('HTTP API: protected_paths is empty, all endpoints are public');
    } else {
      log.info(
        `HTTP API: token required for ${protectedPatterns.length} path pattern(s), public ${publicPatterns.length}`,
      );
    }
  });
  server.on('error', (e) => log.error(`HTTP API server error: ${e.stack || e.message}`));

  return server;
}
