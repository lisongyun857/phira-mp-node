import net from 'node:net';
import crypto from 'node:crypto';
import { Session } from './session.js';
import { LoginManager } from './login.js';
import { loadConfig } from './config.js';
import { isIpBanned } from './bans.js';
import { log } from './logger.js';

export class ServerState {
  constructor(config) {
    this.config = config;
    /** uuid -> Session */
    this.sessions = new Map();
    /** user id -> User */
    this.users = new Map();
    /** room id -> Room */
    this.rooms = new Map();
    /** 是否允许玩家在客户端创建房间；控制台/QQ/API 建房不受影响 */
    this.allowClientCreateRoom = config.allowClientCreateRoom !== false;
    this.login = new LoginManager(config.login);
  }
}

export function createServer() {
  const state = new ServerState(loadConfig());
  log.info(
    `loaded ${state.config.announcements.length} announcement(s), online room list ${
      state.config.showOnlineRooms ? 'on' : 'off'
    }`,
  );

  const tcp = net.createServer((socket) => {
    const ipBan = isIpBanned(socket.remoteAddress);
    if (ipBan) {
      log.warn(`rejected banned IP ${socket.remoteAddress}`);
      socket.destroy();
      return;
    }
    const id = crypto.randomUUID();
    const session = new Session(id, socket, state);
    state.sessions.set(id, session);
    log.info(
      `received connection from ${socket.remoteAddress}:${socket.remotePort} (${id})`,
    );
  });

  tcp.on('error', (e) => log.error(`server error: ${e.stack || e.message}`));

  // 全局心跳扫描：所有连接共用一个定时器，避免每会话一个 setInterval
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const session of state.sessions.values()) {
      session.checkHeartbeat(now);
    }
  }, 2000);
  heartbeat.unref();
  tcp.on('close', () => clearInterval(heartbeat));

  return { state, tcp };
}
