import crypto from 'node:crypto';

/**
 * 网页登录会话（内存存储，重启后失效）。
 * 用户用 Phira 邮箱密码登录后，服务端签发随机 token，
 * 前端后续通过 Authorization: Bearer <token> 访问需要身份的房间接口。
 */

const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
/** 同一 IP 在 10 分钟内最多尝试登录 10 次 */
const RATE_WINDOW = 10 * 60 * 1000;
const RATE_MAX = 10;

const sessions = new Map();
const attempts = new Map();

function prune(now = Date.now()) {
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
  for (const [ip, entry] of attempts) {
    if (entry.resetAt <= now) attempts.delete(ip);
  }
}

const timer = setInterval(() => prune(), 10 * 60 * 1000);
timer.unref?.();

export function createWebSession(phira) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const session = {
    token,
    phiraId: phira.id,
    name: phira.name || '',
    avatar: phira.avatar || null,
    createdAt: now,
    expiresAt: now + SESSION_TTL,
  };
  sessions.set(token, session);
  return session;
}

export function getWebSession(token) {
  if (typeof token !== 'string' || !token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return session;
}

export function deleteWebSession(token) {
  if (typeof token === 'string' && token) sessions.delete(token);
}

export function checkLoginRate(ip) {
  const key = ip || 'unknown';
  const now = Date.now();
  let entry = attempts.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + RATE_WINDOW };
    attempts.set(key, entry);
  }
  if (entry.count >= RATE_MAX) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count += 1;
  return { allowed: true };
}

export function resetLoginRate(ip) {
  attempts.delete(ip || 'unknown');
}
