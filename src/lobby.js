import { ROOM_MAX_USERS } from './room.js';

/** 房间 ID 以 _ 开头时视为隐藏房间，不出现在在线房间列表中。 */
export function isHiddenRoom(room) {
  return room.id.startsWith('_');
}

/** 公开（非隐藏）房间列表。 */
export function visibleRooms(server) {
  return [...server.rooms.values()].filter((room) => !isHiddenRoom(room));
}

/** 房间阶段文案：用于在线房间列表展示是否已经开始游戏。 */
export function roomStateName(room) {
  switch (room.state.kind) {
    case 'SelectChart':
      return '未开始';
    case 'WaitForReady':
      return '准备中';
    case 'Playing':
      return '游戏中';
    default:
      return '未知';
  }
}

export function formatRoomLine(room) {
  const chart = room.chart ? room.chart.name : '未选谱';
  const lock = room.locked ? ' · 已锁定' : '';
  return `${room.id} · ${room.users.length}/${ROOM_MAX_USERS} 人 · ${roomStateName(room)} · ${chart}${lock}`;
}

/** 生成用户连接服务器后展示的公告与在线房间列表。 */
export function buildLobbyMessages(server) {
  const messages = [];

  for (const line of server.config.announcements) {
    messages.push(`【公告】${line}`);
  }

  if (!server.config.showOnlineRooms) return messages;

  const rooms = visibleRooms(server);
  if (rooms.length === 0) {
    messages.push('【在线房间】暂无');
    return messages;
  }

  messages.push(`【在线房间】共 ${rooms.length} 个`);
  for (const room of rooms) {
    messages.push(`【在线房间】${formatRoomLine(room)}`);
  }
  return messages;
}
