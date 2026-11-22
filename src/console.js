import readline from 'node:readline';
import { loadConfig } from './config.js';
import { log } from './logger.js';
import { Room, ROOM_MAX_USERS } from './room.js';
import { isValidRoomId } from './protocol/models.js';
import { roomStateName } from './lobby.js';

const HELP_TEXT = `可用命令：
  help                     显示帮助
  status                   查看服务器状态
  rooms                    列出所有房间（含隐藏房间）
  create <房间ID>          创建房间，第一个加入的玩家成为房主
  roomlock on|off          禁止/允许玩家在客户端创建房间（指令建房不受影响）
  say <房间ID|all> <内容>  向房间发送管理消息
  announce <内容>          向所有在线用户发送公告
  reload                   重新加载 server_config.yml
  stop                     关闭服务器`;

const USAGE = {
  create: '用法：create <房间ID>',
  roomlock: '用法：roomlock on|off',
  say: '用法：say <房间ID|all> <内容>',
  announce: '用法：announce <内容>',
};

function splitCommand(line) {
  const trimmed = line.trim();
  if (!trimmed) return { cmd: '', rest: '' };
  const index = trimmed.indexOf(' ');
  if (index === -1) return { cmd: trimmed.toLowerCase(), rest: '' };
  return { cmd: trimmed.slice(0, index).toLowerCase(), rest: trimmed.slice(index + 1).trim() };
}

function formatDuration(totalSeconds) {
  const total = Math.floor(totalSeconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}天`);
  if (days > 0 || hours > 0) parts.push(`${hours}小时`);
  if (days > 0 || hours > 0 || minutes > 0) parts.push(`${minutes}分`);
  parts.push(`${seconds}秒`);
  return parts.join('');
}

function describeRoom(room) {
  const flags = [];
  if (room.id.startsWith('_')) flags.push('隐藏');
  if (room.locked) flags.push('锁定');
  if (room.cycle) flags.push('轮换');
  const flagsText = flags.length > 0 ? ` [${flags.join(' ')}]` : '';
  const chart = room.chart ? room.chart.name : '未选谱';
  return `${room.id}${flagsText} ${roomStateName(room)} 玩家 ${room.users.length}/${ROOM_MAX_USERS} 旁观 ${room.monitors.length} 谱面 ${chart}`;
}

export function createConsoleHandler(state, tcp) {
  return (line) => {
    const { cmd, rest } = splitCommand(line);
    if (!cmd) return;

    log.info(`console: ${line.trim()}`);

    switch (cmd) {
      case 'help':
        console.log(HELP_TEXT);
        break;

      case 'status': {
        const memory = Math.round(process.memoryUsage().rss / 1024 / 1024);
        console.log(
          `运行时间 ${formatDuration(process.uptime())} · 在线用户 ${state.users.size} · 连接 ${state.sessions.size} · 房间 ${state.rooms.size} · 客户端建房 ${state.allowClientCreateRoom ? '允许' : '禁止'} · 内存 ${memory} MB`,
        );
        break;
      }

      case 'rooms':
        if (state.rooms.size === 0) {
          console.log('当前没有房间');
        } else {
          for (const room of state.rooms.values()) {
            console.log(describeRoom(room));
          }
        }
        break;

      case 'create': {
        if (!rest) {
          console.log(USAGE.create);
          break;
        }
        if (!isValidRoomId(rest)) {
          console.log('房间 ID 只能包含字母、数字、-、_，长度 1~20');
          break;
        }
        if (state.rooms.has(rest)) {
          console.log(`房间 ${rest} 已存在`);
          break;
        }
        const room = new Room(rest, null);
        state.rooms.set(rest, room);
        log.info(`console create room ${rest}`);
        console.log(
          `已创建房间 ${rest}${rest.startsWith('_') ? '（隐藏）' : ''}，第一个加入的玩家将成为房主`,
        );
        break;
      }

      case 'roomlock': {
        const value = rest.toLowerCase();
        if (!value) {
          console.log(
            `客户端建房当前${state.allowClientCreateRoom ? '允许' : '禁止'}，用法：roomlock on|off`,
          );
          break;
        }
        if (['on', 'enable', 'enabled', 'true', 'allow'].includes(value)) {
          state.allowClientCreateRoom = true;
        } else if (['off', 'disable', 'disabled', 'false', 'deny'].includes(value)) {
          state.allowClientCreateRoom = false;
        } else {
          console.log(USAGE.roomlock);
          break;
        }
        log.info(
          `client room creation ${state.allowClientCreateRoom ? 'enabled' : 'disabled'} from console`,
        );
        console.log(
          state.allowClientCreateRoom
            ? '已允许玩家在客户端创建房间'
            : '已禁止玩家在客户端创建房间（控制台、QQ、API 建房不受影响）',
        );
        break;
      }

      case 'say': {
        const space = rest.indexOf(' ');
        if (space === -1) {
          console.log(USAGE.say);
          break;
        }
        const target = rest.slice(0, space).trim();
        const content = rest.slice(space + 1).trim();
        if (!target || !content) {
          console.log(USAGE.say);
          break;
        }
        if (target === 'all') {
          for (const room of state.rooms.values()) {
            room.sendMessage({ type: 'Chat', user: 0, content: `【管理】${content}` });
          }
          console.log(`已向 ${state.rooms.size} 个房间发送管理消息`);
        } else {
          const room = state.rooms.get(target);
          if (!room) {
            console.log(`房间 ${target} 不存在`);
            break;
          }
          room.sendMessage({ type: 'Chat', user: 0, content: `【管理】${content}` });
          console.log(`已向房间 ${target} 发送管理消息`);
        }
        break;
      }

      case 'announce': {
        if (!rest) {
          console.log(USAGE.announce);
          break;
        }
        for (const user of state.users.values()) {
          user.trySend({
            type: 'Message',
            message: { type: 'Chat', user: 0, content: `【公告】${rest}` },
          });
        }
        console.log(`已向 ${state.users.size} 位在线用户发送公告`);
        break;
      }

      case 'reload':
        state.config = loadConfig();
        log.info(
          `config reloaded: ${state.config.announcements.length} announcement(s), online room list ${
            state.config.showOnlineRooms ? 'on' : 'off'
          }`,
        );
        console.log(
          `已重新加载配置：公告 ${state.config.announcements.length} 条，在线房间列表 ${
            state.config.showOnlineRooms ? '开启' : '关闭'
          }`,
        );
        break;

      case 'stop':
        console.log('正在关闭服务器…');
        log.info('server stopping from console');
        tcp.close();
        setTimeout(() => process.exit(0), 200).unref();
        break;

      default:
        console.log(`未知命令：${cmd}，输入 help 查看帮助`);
    }
  };
}

export function startConsole(state, tcp) {
  if (!process.stdin || !process.stdin.readable) return null;

  const handler = createConsoleHandler(state, tcp);
  const isTTY = Boolean(process.stdin.isTTY);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: isTTY,
  });

  if (isTTY) {
    console.log('控制台已就绪，输入 help 查看可用命令');
    rl.setPrompt('phira-mp> ');
    rl.prompt();
  }

  rl.on('line', (line) => {
    try {
      handler(line);
    } catch (e) {
      log.error(`console command failed: ${e.stack || e}`);
      console.log(`命令执行失败：${e.message}`);
    }
    if (isTTY) rl.prompt();
  });

  return rl;
}
