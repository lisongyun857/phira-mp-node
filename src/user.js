import { log } from './logger.js';

const DANGLE_TIMEOUT = 10_000;

export class User {
  constructor(id, name, lang, server) {
    this.id = id;
    this.name = name;
    this.lang = lang;
    this.server = server;

    /** 当前会话（Session） */
    this.session = null;
    /** 当前所在房间（Room） */
    this.room = null;

    this.monitor = false;
    this.gameTime = -Infinity;

    /** 用于标记 dangle 超时是否仍然有效 */
    this.dangleMark = null;
  }

  toInfo() {
    return { id: this.id, name: this.name, monitor: this.monitor };
  }

  canMonitor() {
    return this.server.config.monitors.includes(this.id);
  }

  setSession(session) {
    this.session = session;
    this.dangleMark = null;
  }

  trySend(cmd) {
    if (this.session) {
      this.session.send(cmd);
    } else {
      log.warn(`sending ${cmd.type} to dangling user ${this.id}`);
    }
  }

  /** 发送已编码的数据帧，避免同一广播对每个接收者重复编码 */
  trySendFrame(frame, realtime = false) {
    if (this.session) {
      this.session.sendFrame(frame, realtime);
      return true;
    }
    log.warn(`sending frame to dangling user ${this.id}`);
    return false;
  }

  /**
   * 会话丢失后的处理：
   * - 游戏中直接退出房间
   * - 否则保留 10 秒等待重连，超时后再退出
   */
  dangle() {
    log.warn(`user ${this.id} dangling`);
    const room = this.room;

    if (room && room.state.kind === 'Playing') {
      log.warn(`user ${this.id} lost connection on playing, aborting`);
      this.server.users.delete(this.id);
      if (room.onUserLeave(this)) this.server.rooms.delete(room.id);
      return;
    }

    const mark = {};
    this.dangleMark = mark;
    setTimeout(() => {
      if (this.dangleMark !== mark) return;
      const currentRoom = this.room;
      if (!currentRoom) return;
      this.server.users.delete(this.id);
      if (currentRoom.onUserLeave(this)) this.server.rooms.delete(currentRoom.id);
    }, DANGLE_TIMEOUT);
  }
}
