import { WebSocketServer } from 'ws';
import { Room } from './room.js';
import { isValidRoomId } from './protocol/models.js';
import { visibleRooms, formatRoomLine } from './lobby.js';
import { log } from './logger.js';

const DEFAULT_OPTIONS = {
  enabled: true,
  port: 3001,
  accessToken: '',
  adminQQ: [],
  groupIds: [],
  reportInterval: 300,
};

const HELP_TEXT = `可用命令（需要以 # 开头）：
#房间                查看在线房间
#房间 全部           查看全部房间（含隐藏，管理员）
#创建房间 <房间ID>   创建房间（管理员）
#删除房间 <房间ID>   解散并删除房间（管理员）
#管理消息 <房间ID|all> <内容>  发送管理消息（管理员）
#建房开关 开|关       禁止/允许玩家在客户端创建房间（管理员）
#公告 <内容>         向所有在线玩家发送公告（管理员）
#状态                查看服务器状态
#帮助                显示本帮助`;

function splitCommand(text) {
  if (!text.startsWith('#')) return null;
  const body = text.slice(1).trim();
  if (!body) return null;
  const space = body.indexOf(' ');
  if (space === -1) return { cmd: body.toLowerCase(), rest: '' };
  return { cmd: body.slice(0, space).toLowerCase(), rest: body.slice(space + 1).trim() };
}

function extractText(event) {
  let text = event.raw_message;
  if (typeof text !== 'string') {
    if (Array.isArray(event.message)) {
      text = event.message
        .map((segment) => (segment && segment.type === 'text' ? segment.data.text : ''))
        .join('');
    } else {
      text = '';
    }
  }
  return text.replace(/\[CQ:[^\]]*\]/g, '').trim();
}

function formatDuration(totalSeconds) {
  const total = Math.floor(totalSeconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}小时${minutes}分${seconds}秒` : `${minutes}分${seconds}秒`;
}

function roomListText(rooms, includeHidden) {
  const list = rooms.filter((room) => includeHidden || !room.id.startsWith('_'));
  if (list.length === 0) return '当前没有在线房间';
  const lines = [`在线房间（${list.length}）：`];
  list.forEach((room, index) => {
    lines.push(`${index + 1}. ${formatRoomLine(room)}${room.id.startsWith('_') ? ' [隐藏]' : ''}`);
  });
  return lines.join('\n');
}

function reply(send, event, content) {
  if (event.message_type === 'group') {
    send('send_group_msg', { group_id: event.group_id, message: content });
  } else {
    send('send_private_msg', { user_id: event.user_id, message: content });
  }
}

function handleMessage(state, options, event, send) {
  const text = extractText(event);
  const parsed = splitCommand(text);
  if (!parsed) return;

  const { cmd, rest } = parsed;
  const userId = Number(event.user_id);
  const isAdmin = options.adminQQ.includes(userId);
  const respond = (content) => reply(send, event, content);

  switch (cmd) {
    case '帮助':
    case 'help':
      respond(HELP_TEXT);
      break;

    case '房间':
    case '房间列表':
    case '列表':
    case 'rooms': {
      const includeHidden = rest === '全部' || rest === 'all';
      if (includeHidden && !isAdmin) {
        respond('权限不足：只有管理员 QQ 可以查看隐藏房间');
        break;
      }
      respond(roomListText([...state.rooms.values()], includeHidden));
      break;
    }

    case '创建房间':
    case '建房':
    case 'create': {
      if (!isAdmin) {
        respond('权限不足：只有管理员 QQ 可以创建房间');
        break;
      }
      if (!rest) {
        respond('用法：#创建房间 <房间ID>');
        break;
      }
      if (!isValidRoomId(rest)) {
        respond('房间 ID 只能包含字母、数字、-、_，长度 1~20');
        break;
      }
      if (state.rooms.has(rest)) {
        respond(`房间 ${rest} 已存在`);
        break;
      }
      const room = new Room(rest, null);
      state.rooms.set(rest, room);
      log.info(`QQ bot: user ${userId} created room ${rest}`);
      respond(
        `已创建房间 ${rest}${rest.startsWith('_') ? '（隐藏）' : ''}，第一个加入的玩家将成为房主`,
      );
      break;
    }

    case '删除房间':
    case '解散房间':
    case 'delete': {
      if (!isAdmin) {
        respond('权限不足：只有管理员 QQ 可以删除房间');
        break;
      }
      if (!rest) {
        respond('用法：#删除房间 <房间ID>');
        break;
      }
      const room = state.rooms.get(rest);
      if (!room) {
        respond(`房间 ${rest} 不存在`);
        break;
      }
      const members = [...room.users, ...room.monitors];
      if (members.length > 0) {
        room.sendMessage({ type: 'Chat', user: 0, content: '【管理】房间已被管理员解散' });
      }
      for (const member of members) {
        member.room = null;
        member.monitor = false;
        log.info(`QQ bot: detached user ${member.id} from deleted room ${rest}`);
      }
      room.users.length = 0;
      room.monitors.length = 0;
      state.rooms.delete(rest);
      log.info(`QQ bot: user ${userId} deleted room ${rest} (${members.length} member(s))`);
      respond(`已删除房间 ${rest}，已通知房间内 ${members.length} 人离开`);
      break;
    }

    case '管理消息':
    case '喊话':
    case 'say': {
      if (!isAdmin) {
        respond('权限不足：只有管理员 QQ 可以发送管理消息');
        break;
      }
      const space = rest.indexOf(' ');
      if (space === -1) {
        respond('用法：#管理消息 <房间ID|all> <内容>');
        break;
      }
      const target = rest.slice(0, space).trim();
      const content = rest.slice(space + 1).trim();
      if (!target || !content) {
        respond('用法：#管理消息 <房间ID|all> <内容>');
        break;
      }
      if (target === 'all') {
        for (const room of state.rooms.values()) {
          room.sendMessage({ type: 'Chat', user: 0, content: `【管理】${content}` });
        }
        log.info(`QQ bot: user ${userId} broadcast to ${state.rooms.size} rooms`);
        respond(`已向 ${state.rooms.size} 个房间发送管理消息`);
        break;
      }
      const room = state.rooms.get(target);
      if (!room) {
        respond(`房间 ${target} 不存在`);
        break;
      }
      room.sendMessage({ type: 'Chat', user: 0, content: `【管理】${content}` });
      log.info(`QQ bot: user ${userId} message to room ${target}`);
      respond(`已向房间 ${target} 发送管理消息`);
      break;
    }

    case '公告':
    case 'announce': {
      if (!isAdmin) {
        respond('权限不足：只有管理员 QQ 可以发送公告');
        break;
      }
      if (!rest) {
        respond('用法：#公告 <内容>');
        break;
      }
      for (const user of state.users.values()) {
        user.trySend({
          type: 'Message',
          message: { type: 'Chat', user: 0, content: `【公告】${rest}` },
        });
      }
      log.info(`QQ bot: user ${userId} announced to ${state.users.size} users`);
      respond(`已向 ${state.users.size} 位在线玩家发送公告`);
      break;
    }

    case '建房开关':
    case '房间创建':
    case 'roomlock': {
      if (!isAdmin) {
        respond('权限不足：只有管理员 QQ 可以切换建房开关');
        break;
      }
      const value = rest.toLowerCase();
      if (!value) {
        respond(`当前${state.allowClientCreateRoom ? '允许' : '禁止'}玩家在客户端创建房间`);
        break;
      }
      if (['开', 'on', 'enable', 'enabled', 'true', '允许'].includes(value)) {
        state.allowClientCreateRoom = true;
      } else if (['关', 'off', 'disable', 'disabled', 'false', '禁止'].includes(value)) {
        state.allowClientCreateRoom = false;
      } else {
        respond('用法：#建房开关 开|关');
        break;
      }
      log.info(
        `QQ bot: user ${userId} ${state.allowClientCreateRoom ? 'enabled' : 'disabled'} client room creation`,
      );
      respond(
        state.allowClientCreateRoom
          ? '已允许玩家在客户端创建房间'
          : '已禁止玩家在客户端创建房间（控制台、QQ、API 建房不受影响）',
      );
      break;
    }

    case '状态':
    case 'status': {
      const memory = Math.round(process.memoryUsage().rss / 1024 / 1024);
      respond(
        `运行时间 ${formatDuration(process.uptime())} · 在线用户 ${state.users.size} · 连接 ${state.sessions.size} · 房间 ${state.rooms.size} · 客户端建房 ${state.allowClientCreateRoom ? '允许' : '禁止'} · 内存 ${memory} MB`,
      );
      break;
    }

    default:
      respond(`未知命令：${cmd}，发送 #帮助 查看可用命令`);
  }
}

function sendAction(clients, action, params) {
  const socket = pickSocket(clients);
  if (!socket) {
    log.warn(`QQ bot: no available client, dropping action ${action}`);
    return false;
  }
  try {
    socket.send(JSON.stringify({ action, params, echo: `${action}-${Date.now()}` }));
    return true;
  } catch (e) {
    log.warn(`QQ bot: failed to send ${action}: ${e.message}`);
    return false;
  }
}

function pickSocket(clients) {
  let fallback = null;
  for (const client of clients) {
    if (client.socket.readyState !== 1) continue;
    const role = String(client.role || '').toLowerCase();
    if (role === 'api' || role === 'universal' || role === '') return client.socket;
    fallback = client.socket;
  }
  return fallback;
}

function isAuthorized(req, token) {
  const header = req.headers.authorization || '';
  if (header === `Bearer ${token}` || header === token) return true;
  try {
    const url = new URL(req.url, 'ws://localhost');
    return url.searchParams.get('access_token') === token;
  } catch {
    return false;
  }
}

export function startQQBot(state, options) {
  const config = { ...DEFAULT_OPTIONS, ...(options || state.config.qqBot || {}) };
  if (!config.enabled) {
    log.info('QQ bot disabled');
    return null;
  }

  const clients = new Set();
  const server = new WebSocketServer({ port: config.port });
  const send = (action, params) => sendAction(clients, action, params);

  server.on('connection', (socket, req) => {
    if (config.accessToken && !isAuthorized(req, config.accessToken)) {
      log.warn(`QQ bot: rejected connection from ${req.socket.remoteAddress} (bad token)`);
      socket.close(1008, 'unauthorized');
      return;
    }

    const client = {
      socket,
      role: req.headers['x-client-role'] || '',
      selfId: req.headers['x-self-id'] || '',
    };
    clients.add(client);
    log.info(
      `QQ bot: client connected (role=${client.role || 'unknown'}, self=${client.selfId || 'unknown'})`,
    );

    socket.on('message', (data) => {
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch (e) {
        log.warn(`QQ bot: invalid json: ${e.message}`);
        return;
      }
      if (!event || typeof event !== 'object') return;
      if (event.post_type === 'message') {
        try {
          handleMessage(state, config, event, send);
        } catch (e) {
          log.error(`QQ bot: command failed: ${e.stack || e}`);
        }
      }
    });

    socket.on('close', () => {
      clients.delete(client);
      log.info('QQ bot: client disconnected');
    });
    socket.on('error', (e) => log.warn(`QQ bot socket error: ${e.message}`));
  });

  server.on('listening', () => {
    log.info(`QQ bot: WebSocket server listening on :${config.port}`);
    if (config.adminQQ.length === 0) {
      log.warn('QQ bot: admin_qq is empty, room management commands are disabled');
    }
    if (config.reportInterval > 0 && config.groupIds.length > 0) {
      log.info(
        `QQ bot: online room report every ${config.reportInterval}s to ${config.groupIds.length} group(s)`,
      );
    }
  });

  server.on('error', (e) => log.error(`QQ bot server error: ${e.stack || e}`));

  let timer = null;
  if (config.reportInterval > 0 && config.groupIds.length > 0) {
    timer = setInterval(() => {
      const rooms = visibleRooms(state);
      if (rooms.length === 0) {
        log.debug('QQ bot: no online rooms, skip report');
        return;
      }
      const text = roomListText(rooms, false);
      for (const groupId of config.groupIds) {
        sendAction(clients, 'send_group_msg', { group_id: groupId, message: text });
      }
      log.debug(`QQ bot: reported ${rooms.length} room(s) to ${config.groupIds.length} group(s)`);
    }, config.reportInterval * 1000);
  }

  return {
    close() {
      if (timer) clearInterval(timer);
      for (const client of clients) client.socket.close();
      server.close();
    },
  };
}
