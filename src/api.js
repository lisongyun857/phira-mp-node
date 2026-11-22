import http from 'node:http';
import { Room, ROOM_MAX_USERS } from './room.js';
import { isValidRoomId } from './protocol/models.js';
import { handleLoginPage, normalizeLoginIdentity } from './login.js';
import { log } from './logger.js';

const MAX_BODY_BYTES = 64 * 1024;

const DEFAULT_OPTIONS = {
  enabled: true,
  host: '127.0.0.1',
  port: 3052,
  accessToken: '',
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

function isAuthorized(req, token) {
  if (!token) return true;
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

    const members = [...room.users, ...room.monitors];
    if (members.length > 0) {
      room.sendMessage({ type: 'Chat', user: 0, content: '【管理】房间已被管理员解散' });
    }
    for (const member of members) {
      member.room = null;
      member.monitor = false;
      log.info(`API: detached user ${member.id} from deleted room ${id}`);
    }
    room.users.length = 0;
    room.monitors.length = 0;
    state.rooms.delete(id);
    log.info(`API: deleted room ${id} (${members.length} member(s))`);
    ok(res, { id, members: members.length });
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
    if (!isAuthorized(req, config.accessToken)) {
      fail(res, 401, 'unauthorized');
      return;
    }
    handleRequest(state, req, res).catch((e) => {
      log.warn(`API: ${req.method} ${req.url} failed: ${e.message}`);
      if (!res.headersSent) fail(res, 400, e.message);
    });
  });

  server.listen(config.port, config.host, () => {
    log.info(`HTTP API listening on http://${config.host}:${config.port}`);
    if (!config.accessToken) {
      log.warn('HTTP API: access_token is empty, make sure the port is not exposed publicly');
    }
  });
  server.on('error', (e) => log.error(`HTTP API server error: ${e.stack || e.message}`));

  return server;
}
