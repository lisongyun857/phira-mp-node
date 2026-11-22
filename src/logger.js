import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
const LEVEL_NAMES = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'];
const threshold = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

const LOG_DIR = 'log';
let logDirReady = false;

function currentLogFile() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `phira-mp.${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}`;
  return path.join(LOG_DIR, name);
}

function writeToFile(line) {
  try {
    if (!logDirReady) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      logDirReady = true;
    }
    fs.appendFileSync(currentLogFile(), `${line}\n`, 'utf8');
  } catch {
    // 日志写入失败时不影响服务
  }
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
  const message = args.map(format).join(' ');
  const line = `${new Date().toISOString()} ${LEVEL_NAMES[levelNum]} ${message}`;
  writeToFile(line);
  if (levelNum >= threshold) {
    const stream = levelNum >= LEVELS.warn ? console.error : console.log;
    stream(line);
  }
}

export const log = {
  trace: (...args) => emit('trace', args),
  debug: (...args) => emit('debug', args),
  info: (...args) => emit('info', args),
  warn: (...args) => emit('warn', args),
  error: (...args) => emit('error', args),
};
