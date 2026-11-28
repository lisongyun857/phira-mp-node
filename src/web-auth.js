import crypto from 'node:crypto';

/**
 * 登录会话（内存存储，重启后失效）。
 * - web：普通用户用 Phira 邮箱密码登录后签发
 * - admin：管理面板用管理员密码登录后签发
 */

const WEB_TTL = 7 * 24 * 60 * 60 * 1000;
const ADMIN_TTL = 12 * 60 * 60 * 1000;
/** 同一 IP 在 10 分钟内最多尝试登录 10 次（按登录类型分别计数） */
const RATE_WINDOW = 10 * 60 * 1000;
const RATE_MAX = 10;

const sessions = new Map();
const attempts = new Map();

function prune(now = Date.now()) {
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
  for (const [key, entry] of attempts) {
    if (entry.resetAt <= now) attempts.delete(key);
  }
}

const timer = setInterval(() => prune(), 10 * 60 * 1000);
timer.unref?.();

function createSession(role, ttl, extra) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const session = {
    token,
    role,
    createdAt: now,
    expiresAt: now + ttl,
    ...extra,
  };
  sessions.set(token, session);
  return session;
}

function getSession(token, role) {
  if (typeof token !== 'string' || !token) return null;
  const session = sessions.get(token);
  if (!session || session.role !== role) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return session;
}

export function createWebSession(phira) {
  return createSession('web', WEB_TTL, {
    phiraId: phira.id,
    name: phira.name || '',
    avatar: phira.avatar || null,
  });
}

export function getWebSession(token) {
  return getSession(token, 'web');
}

export function deleteWebSession(token) {
  if (typeof token === 'string' && token) sessions.delete(token);
}

export function createAdminSession(meta = {}) {
  return createSession('admin', ADMIN_TTL, { name: meta.name || 'admin' });
}

export function getAdminSession(token) {
  return getSession(token, 'admin');
}

export function deleteAdminSession(token) {
  if (typeof token === 'string' && token) sessions.delete(token);
}

/** 使其他管理员会话失效（修改密码后调用），可选保留当前会话。 */
export function invalidateAdminSessions(exceptToken = '') {
  for (const [token, session] of sessions) {
    if (session.role === 'admin' && token !== exceptToken) sessions.delete(token);
  }
}

export function checkLoginRate(ip, scope = 'web') {
  const key = `${scope}:${ip || 'unknown'}`;
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

export function resetLoginRate(ip, scope = 'web') {
  attempts.delete(`${scope}:${ip || 'unknown'}`);
}
