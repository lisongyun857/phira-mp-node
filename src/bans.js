/**
 * 内存封禁（重启失效）。
 * 支持按 IP 或 Phira 用户 ID 封禁，到期自动解除。
 */

const KEY_IP = (ip) => `ip:${ip}`;
const KEY_USER = (id) => `user:${Number(id)}`;

const bans = new Map();

function normalize(value) {
  return String(value ?? '').trim();
}

function normalizeIp(value) {
  let ip = normalize(value);
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function prune(now = Date.now()) {
  for (const [key, ban] of bans) {
    if (ban.expiresAt !== null && ban.expiresAt <= now) bans.delete(key);
  }
}

const timer = setInterval(() => prune(), 60 * 1000);
timer.unref?.();

export function addBan({ type, value, minutes = 60, reason = '' }) {
  const kind = type === 'user' ? 'user' : 'ip';
  const target = kind === 'user' ? normalize(value) : normalizeIp(value);
  if (!target) throw new Error('封禁目标不能为空');
  const duration = Number(minutes);
  const now = Date.now();
  const ban = {
    type: kind,
    value: kind === 'user' ? Number(target) : target,
    reason: normalize(reason).slice(0, 200),
    createdAt: now,
    expiresAt: Number.isFinite(duration) && duration > 0 ? now + duration * 60 * 1000 : null,
  };
  if (kind === 'user' && !Number.isInteger(ban.value)) throw new Error('Phira ID 必须是整数');
  bans.set(kind === 'user' ? KEY_USER(target) : KEY_IP(target), ban);
  return ban;
}

export function removeBan(type, value) {
  const kind = type === 'user' ? 'user' : 'ip';
  const target = kind === 'user' ? normalize(value) : normalizeIp(value);
  return bans.delete(kind === 'user' ? KEY_USER(target) : KEY_IP(target));
}

export function isIpBanned(ip) {
  const target = normalizeIp(ip);
  if (!target) return null;
  return bans.get(KEY_IP(target)) || null;
}

export function isUserBanned(id) {
  if (id === undefined || id === null) return null;
  return bans.get(KEY_USER(id)) || null;
}

export function listBans() {
  prune();
  return [...bans.values()].sort((a, b) => b.createdAt - a.createdAt);
}
