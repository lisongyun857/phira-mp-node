/**
 * phira-mp 协议模型。
 * 枚举按变体声明顺序用 u8 作为 tag，字段按声明顺序序列化。
 */
import { BinaryReader, BinaryWriter } from './binary.js';

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;

export function isValidRoomId(id) {
  return typeof id === 'string' && ROOM_ID_PATTERN.test(id);
}

export function ok(value) {
  return { ok: true, value };
}

export function err(error) {
  return { ok: false, error };
}

function readVarchar(r, max) {
  const len = r.uleb();
  if (len > max) throw new Error('string too long');
  return r.take(len).toString('utf8');
}

function readRoomId(r) {
  const id = readVarchar(r, 20);
  if (!isValidRoomId(id)) throw new Error('invalid room id');
  return id;
}

/** 解码客户端命令；失败时抛出异常。 */
export function decodeClientCommand(payload) {
  const r = new BinaryReader(payload);
  const tag = r.u8();
  switch (tag) {
    case 0:
      return { type: 'Ping' };
    case 1:
      return { type: 'Authenticate', token: readVarchar(r, 32) };
    case 2:
      return { type: 'Chat', message: readVarchar(r, 200) };
    case 3:
      return {
        type: 'Touches',
        frames: r.array((rr) => ({
          time: rr.f32(),
          points: rr.array((rrr) => ({
            id: rrr.i8(),
            // 直接保留 f16 位模式，转发时原样写回
            x: rrr.u16(),
            y: rrr.u16(),
          })),
        })),
      };
    case 4: {
      const judges = r.array((rr) => ({
        time: rr.f32(),
        lineId: rr.u32(),
        noteId: rr.u32(),
        judgement: rr.u8(),
      }));
      for (const judge of judges) {
        if (judge.judgement > 5) throw new Error(`invalid enum: ${judge.judgement}`);
      }
      return { type: 'Judges', judges };
    }
    case 5:
      return { type: 'CreateRoom', id: readRoomId(r) };
    case 6:
      return { type: 'JoinRoom', id: readRoomId(r), monitor: r.bool() };
    case 7:
      return { type: 'LeaveRoom' };
    case 8:
      return { type: 'LockRoom', lock: r.bool() };
    case 9:
      return { type: 'CycleRoom', cycle: r.bool() };
    case 10:
      return { type: 'SelectChart', id: r.i32() };
    case 11:
      return { type: 'RequestStart' };
    case 12:
      return { type: 'Ready' };
    case 13:
      return { type: 'CancelReady' };
    case 14:
      return { type: 'Played', id: r.i32() };
    case 15:
      return { type: 'Abort' };
    default:
      throw new Error(`invalid enum: ${tag}`);
  }
}

function writeUserInfo(w, user) {
  w.i32(user.id);
  w.str(user.name);
  w.bool(user.monitor);
}

/** state: { kind: 'SelectChart'|'WaitForReady'|'Playing', chart?: number|null } */
function writeRoomState(w, state) {
  switch (state.kind) {
    case 'SelectChart':
      w.u8(0);
      w.option(state.chart ?? null, (ww, chartId) => ww.i32(chartId));
      break;
    case 'WaitForReady':
      w.u8(1);
      break;
    case 'Playing':
      w.u8(2);
      break;
    default:
      throw new Error(`invalid room state: ${state.kind}`);
  }
}

function writeClientRoomState(w, state) {
  w.str(state.id);
  writeRoomState(w, state.roomState);
  w.bool(state.live);
  w.bool(state.locked);
  w.bool(state.cycle);
  w.bool(state.isHost);
  w.bool(state.isReady);
  w.uleb(state.users.size);
  for (const [id, info] of state.users) {
    w.i32(id);
    writeUserInfo(w, info);
  }
}

function writeMessage(w, msg) {
  switch (msg.type) {
    case 'Chat':
      w.u8(0);
      w.i32(msg.user);
      w.str(msg.content);
      break;
    case 'CreateRoom':
      w.u8(1);
      w.i32(msg.user);
      break;
    case 'JoinRoom':
      w.u8(2);
      w.i32(msg.user);
      w.str(msg.name);
      break;
    case 'LeaveRoom':
      w.u8(3);
      w.i32(msg.user);
      w.str(msg.name);
      break;
    case 'NewHost':
      w.u8(4);
      w.i32(msg.user);
      break;
    case 'SelectChart':
      w.u8(5);
      w.i32(msg.user);
      w.str(msg.name);
      w.i32(msg.id);
      break;
    case 'GameStart':
      w.u8(6);
      w.i32(msg.user);
      break;
    case 'Ready':
      w.u8(7);
      w.i32(msg.user);
      break;
    case 'CancelReady':
      w.u8(8);
      w.i32(msg.user);
      break;
    case 'CancelGame':
      w.u8(9);
      w.i32(msg.user);
      break;
    case 'StartPlaying':
      w.u8(10);
      break;
    case 'Played':
      w.u8(11);
      w.i32(msg.user);
      w.i32(msg.score);
      w.f32(msg.accuracy);
      w.bool(msg.fullCombo);
      break;
    case 'GameEnd':
      w.u8(12);
      break;
    case 'Abort':
      w.u8(13);
      w.i32(msg.user);
      break;
    case 'LockRoom':
      w.u8(14);
      w.bool(msg.lock);
      break;
    case 'CycleRoom':
      w.u8(15);
      w.bool(msg.cycle);
      break;
    default:
      throw new Error(`invalid message: ${msg.type}`);
  }
}

/** 编码服务端命令，返回 Buffer。 */
export function encodeServerCommand(cmd) {
  const w = new BinaryWriter();
  switch (cmd.type) {
    case 'Pong':
      w.u8(0);
      break;
    case 'Authenticate':
      w.u8(1);
      w.result(cmd.result, (ww, [info, roomState]) => {
        writeUserInfo(ww, info);
        ww.option(roomState, (www, state) => writeClientRoomState(www, state));
      });
      break;
    case 'Chat':
      w.u8(2);
      w.result(cmd.result, () => {});
      break;
    case 'Touches':
      w.u8(3);
      w.i32(cmd.player);
      w.array(cmd.frames, (ww, frame) => {
        ww.f32(frame.time);
        ww.array(frame.points, (www, point) => {
          www.i8(point.id);
          www.u16(point.x);
          www.u16(point.y);
        });
      });
      break;
    case 'Judges':
      w.u8(4);
      w.i32(cmd.player);
      w.array(cmd.judges, (ww, judge) => {
        ww.f32(judge.time);
        ww.u32(judge.lineId);
        ww.u32(judge.noteId);
        ww.u8(judge.judgement);
      });
      break;
    case 'Message':
      w.u8(5);
      writeMessage(w, cmd.message);
      break;
    case 'ChangeState':
      w.u8(6);
      writeRoomState(w, cmd.state);
      break;
    case 'ChangeHost':
      w.u8(7);
      w.bool(cmd.host);
      break;
    case 'CreateRoom':
      w.u8(8);
      w.result(cmd.result, () => {});
      break;
    case 'JoinRoom':
      w.u8(9);
      w.result(cmd.result, (ww, value) => {
        writeRoomState(ww, value.state);
        ww.array(value.users, writeUserInfo);
        ww.bool(value.live);
      });
      break;
    case 'OnJoinRoom':
      w.u8(10);
      writeUserInfo(w, cmd.user);
      break;
    case 'LeaveRoom':
      w.u8(11);
      w.result(cmd.result, () => {});
      break;
    case 'LockRoom':
      w.u8(12);
      w.result(cmd.result, () => {});
      break;
    case 'CycleRoom':
      w.u8(13);
      w.result(cmd.result, () => {});
      break;
    case 'SelectChart':
      w.u8(14);
      w.result(cmd.result, () => {});
      break;
    case 'RequestStart':
      w.u8(15);
      w.result(cmd.result, () => {});
      break;
    case 'Ready':
      w.u8(16);
      w.result(cmd.result, () => {});
      break;
    case 'CancelReady':
      w.u8(17);
      w.result(cmd.result, () => {});
      break;
    case 'Played':
      w.u8(18);
      w.result(cmd.result, () => {});
      break;
    case 'Abort':
      w.u8(19);
      w.result(cmd.result, () => {});
      break;
    default:
      throw new Error(`invalid server command: ${cmd.type}`);
  }
  return w.finish();
}
