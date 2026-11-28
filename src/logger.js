import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
const LEVEL_NAMES = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'];
const threshold = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

const LOG_DIR = 'log';
const FLUSH_INTERVAL = 250;
/** 缓冲区上限，超过后丢弃新日志，避免慢磁盘导致内存无限增长 */
const MAX_BUFFER_CHARS = 4 * 1024 * 1024;

let logDirReady = false;
let buffer = [];
let bufferChars = 0;
let flushTimer = null;
let flushInFlight = false;
let flushQueued = false;

function currentLogFile() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `phira-mp.${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}`;
  return path.join(LOG_DIR, name);
}

function ensureLogDir() {
  if (logDirReady) return true;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logDirReady = true;
    return true;
  } catch {
    return false;
  }
}

/** 异步批量落盘：只在定时器触发时写一次，避免每条日志同步阻塞事件循环 */
function flush() {
  flushTimer = null;
  if (flushInFlight) {
    flushQueued = true;
    return;
  }
  if (buffer.length === 0) return;
  if (!ensureLogDir()) {
    buffer = [];
    bufferChars = 0;
    return;
  }
  const data = `${buffer.join('\n')}\n`;
  const file = currentLogFile();
  buffer = [];
  bufferChars = 0;
  flushInFlight = true;
  fs.appendFile(file, data, 'utf8', () => {
    flushInFlight = false;
    if (flushQueued || buffer.length > 0) {
      flushQueued = false;
      scheduleFlush();
    }
  });
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_INTERVAL);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function enqueue(line) {
  if (bufferChars >= MAX_BUFFER_CHARS) return;
  buffer.push(line);
  bufferChars += line.length + 1;
  scheduleFlush();
}

function format(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function emit(level, args) {
  const levelNum = LEVELS[level];
  if (levelNum < threshold) return;
  const message = args.map(format).join(' ');
  const line = `${new Date().toISOString()} ${LEVEL_NAMES[levelNum]} ${message}`;
  enqueue(line);
  const stream = levelNum >= LEVELS.warn ? console.error : console.log;
  stream(line);
  if (listeners.size > 0) {
    for (const listener of listeners) {
      try {
        listener(line);
      } catch {
        // 单个订阅者异常不影响日志
      }
    }
  }
}

const listeners = new Set();

/** 订阅实时日志（管理面板 SSE），返回取消订阅函数。 */
export function subscribeLogs(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const log = {
  isEnabled: (level) => (LEVELS[level] ?? LEVELS.info) >= threshold,
  trace: (...args) => emit('trace', args),
  debug: (...args) => emit('debug', args),
  info: (...args) => emit('info', args),
  warn: (...args) => emit('warn', args),
  error: (...args) => emit('error', args),
};

// 退出前把剩余日志同步写完
process.on('exit', () => {
  if (buffer.length === 0) return;
  if (!ensureLogDir()) return;
  try {
    fs.appendFileSync(currentLogFile(), `${buffer.join('\n')}\n`, 'utf8');
  } catch {
    // 忽略退出阶段的写入失败
  }
  buffer = [];
  bufferChars = 0;
});
