import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';
import { resolveClientIp } from './client-ip.js';

const PHIRA_API = 'https://phira.5wyxi.com';
const CODE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

const DEFAULT_LOGIN = {
  enabled: true,
  publicUrl: '',
  linkTtl: 600,
  maxAttempts: 5,
  bindingsFile: 'data/bindings.json',
  clientVersion: '0.6.7',
  clientFlavor: 'none',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function maskUserId(userId) {
  const value = String(userId ?? '');
  if (value.length <= 4) return `${value.slice(0, 1)}***`;
  return `${value.slice(0, 3)}****${value.slice(-2)}`;
}

function sendHtml(res, status, html) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    background: linear-gradient(145deg, #191627 0%, #2a2140 50%, #1b2a3a 100%); color: #f4f1ff;
  }
  .card {
    width: 100%; max-width: 420px; padding: 28px; border-radius: 18px;
    background: rgba(26, 23, 38, .88); border: 1px solid rgba(255, 255, 255, .1);
    box-shadow: 0 24px 64px rgba(0, 0, 0, .45); backdrop-filter: blur(10px);
  }
  h1 { margin: 0 0 8px; font-size: 22px; }
  .sub { margin: 0 0 20px; color: #b9b3d0; font-size: 14px; line-height: 1.6; }
  label { display: block; margin: 14px 0 6px; font-size: 13px; color: #cfc9e6; }
  input {
    width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid #4a4266;
    background: #151220; color: #fff; font-size: 15px; outline: none;
  }
  input:focus { border-color: #9d7bff; box-shadow: 0 0 0 3px rgba(157, 123, 255, .18); }
  button {
    width: 100%; margin-top: 20px; padding: 12px 14px; border: 0; border-radius: 10px;
    background: linear-gradient(90deg, #8f6cff, #5d8bff); color: #fff; font-size: 15px;
    font-weight: 600; cursor: pointer;
  }
  button:hover { filter: brightness(1.08); }
  .error {
    margin: 0 0 14px; padding: 10px 12px; border-radius: 10px; font-size: 14px;
    background: rgba(255, 86, 120, .14); border: 1px solid rgba(255, 86, 120, .45); color: #ffb3c4;
  }
  .success {
    margin: 0 0 14px; padding: 12px; border-radius: 10px; font-size: 14px; line-height: 1.7;
    background: rgba(76, 217, 140, .12); border: 1px solid rgba(76, 217, 140, .4); color: #b9ffd4;
  }
  .note { margin: 18px 0 0; font-size: 12px; line-height: 1.7; color: #8f88a8; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #312a4a; color: #cbbcff; font-size: 12px; }
  .muted { color: #8f88a8; }
`;

function page(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="card">${body}</main>
</body>
</html>`;
}

function errorPage(title, message) {
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1><p class="sub">${escapeHtml(message)}</p>`,
  );
}

function formPage(session, { error = '', email = '' } = {}) {
  const target = `${session.platform === 'qq' ? 'QQ' : session.platform} ${maskUserId(session.userId)}`;
  return page(
    '绑定 Phira 账号',
    `<h1>绑定 Phira 账号</h1>
<p class="sub">此链接用于将 Phira 账号绑定到 <span class="badge">${escapeHtml(target)}</span>。<br>请使用 Phira 的邮箱和密码登录。</p>
${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
<form method="post" action="">
  <label for="email">Phira 邮箱</label>
  <input id="email" name="email" type="email" autocomplete="email" required value="${escapeHtml(email)}">
  <label for="password">密码</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">登录并绑定</button>
</form>
<p class="note">密码仅用于本次向 Phira 官方接口验证，不会保存。链接 10 分钟内有效，绑定成功后立即失效。<br>本页面由 Phira 多人服务器提供，非 Phira 官方页面。</p>`,
  );
}

function successPage(binding) {
  const target = `${binding.platform === 'qq' ? 'QQ' : binding.platform} ${maskUserId(binding.userId)}`;
  return page(
    '绑定成功',
    `<h1>绑定成功</h1>
<div class="success">Phira 账号 <strong>${escapeHtml(binding.phiraName || '未命名')}</strong>（ID ${escapeHtml(binding.phiraId)}）已绑定到 ${escapeHtml(target)}。</div>
<p class="sub">请返回 QQ，继续使用登录后的指令。</p>`,
  );
}

async function readBody(req, limit = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function authenticatePhira(config, email, password) {
  const endpoint = `${PHIRA_API}/login`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept-Language': 'zh-CN',
      },
      body: JSON.stringify({
        email,
        password,
        clientVersion: config.clientVersion || DEFAULT_LOGIN.clientVersion,
        clientFlavor: config.clientFlavor || DEFAULT_LOGIN.clientFlavor,
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return { ok: false, error: '无法连接 Phira 服务器，请稍后重试' };
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const code = data && typeof data.code === 'string' ? data.code : '';
    log.warn(`login: Phira /login HTTP ${response.status}${code ? ` ${code}` : ''}`);
    if (
      response.status === 400 ||
      response.status === 401 ||
      code === 'INVALID_INPUT' ||
      code === 'UNAUTHENTICATED'
    ) {
      return { ok: false, error: '邮箱或密码错误' };
    }
    return { ok: false, error: 'Phira 登录失败，请稍后重试' };
  }

  if (!data || typeof data.token !== 'string' || !data.token) {
    return { ok: false, error: 'Phira 返回数据异常，请稍后重试' };
  }

  let me;
  try {
    const meResponse = await fetch(`${PHIRA_API}/me`, {
      headers: {
        Authorization: `Bearer ${data.token}`,
        'Accept-Language': 'zh-CN',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!meResponse.ok) {
      return { ok: false, error: '无法读取 Phira 用户信息，请稍后重试' };
    }
    me = await meResponse.json();
  } catch {
    return { ok: false, error: '无法读取 Phira 用户信息，请稍后重试' };
  }

  const id = me && me.id !== undefined ? me.id : data.id;
  if (id === undefined || id === null) {
    return { ok: false, error: 'Phira 返回数据异常，请稍后重试' };
  }

  return {
    ok: true,
    phira: {
      id,
      name: me && typeof me.name === 'string' ? me.name : '',
      avatar: me && me.avatar ? me.avatar : null,
    },
  };
}

export class LoginManager {
  constructor(config = {}) {
    this.config = { ...DEFAULT_LOGIN, ...config };
    this.bindingsFile = path.resolve(this.config.bindingsFile);
    this.sessions = new Map();
    this.bindings = new Map();
    this.phiraIndex = new Map();
    this.load();
    this.timer = setInterval(() => this.sweep(), 60 * 1000);
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
  }

  sweep(now = Date.now()) {
    for (const [code, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(code);
    }
  }

  createSession(platform, userId) {
    if (!this.config.enabled) return { ok: false, error: '登录功能未启用' };
    const publicUrl = String(this.config.publicUrl || '').trim().replace(/\/+$/, '');
    if (!publicUrl) return { ok: false, error: '未配置 login.public_url' };

    this.sweep();
    const code = crypto.randomBytes(24).toString('base64url');
    const ttl = Math.max(60, Number(this.config.linkTtl) || DEFAULT_LOGIN.linkTtl);
    const expiresAt = Date.now() + ttl * 1000;
    this.sessions.set(code, { platform, userId, expiresAt, attempts: 0 });
    log.info(`login: created link for ${platform}:${userId}`);
    return { ok: true, code, link: `${publicUrl}/login/${code}`, expiresAt };
  }

  getSession(code) {
    const session = this.sessions.get(code);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(code);
      return null;
    }
    return session;
  }

  takeAttempt(code, ip = '') {
    const session = this.getSession(code);
    if (!session) return { ok: false, expired: true };
    session.attempts += 1;
    if (session.attempts > Math.max(1, Number(this.config.maxAttempts) || DEFAULT_LOGIN.maxAttempts)) {
      this.sessions.delete(code);
      log.warn(
        `login: too many attempts for ${session.platform}:${session.userId}${ip ? ` from ${ip}` : ''}`,
      );
      return { ok: false, expired: true };
    }
    return { ok: true, session };
  }

  deleteSession(code) {
    this.sessions.delete(code);
  }

  getBinding(platform, userId) {
    return this.bindings.get(`${platform}:${userId}`) || null;
  }

  bind(platform, userId, phira) {
    const key = `${platform}:${userId}`;
    const phiraKey = String(phira.id);
    const owner = this.phiraIndex.get(phiraKey);
    if (owner && owner !== key) {
      return { ok: false, error: '该 Phira 账号已绑定其他 QQ，请先在原 QQ 解绑' };
    }

    const beforeBindings = new Map(this.bindings);
    const beforeIndex = new Map(this.phiraIndex);
    const previous = this.bindings.get(key);
    const previousPhiraKey = previous ? String(previous.phiraId) : null;

    const binding = {
      platform,
      userId,
      phiraId: phira.id,
      phiraName: phira.name || '',
      phiraAvatar: phira.avatar || null,
      boundAt: new Date().toISOString(),
    };
    this.bindings.set(key, binding);
    this.phiraIndex.set(phiraKey, key);
    if (previousPhiraKey && previousPhiraKey !== phiraKey) {
      this.phiraIndex.delete(previousPhiraKey);
    }

    try {
      this.save();
    } catch (e) {
      this.bindings = beforeBindings;
      this.phiraIndex = beforeIndex;
      log.error(`login: failed to save bindings: ${e.message}`);
      return { ok: false, error: '保存绑定失败，请稍后重试' };
    }

    log.info(`login: bound ${key} -> phira ${phiraKey}${binding.phiraName ? ` (${binding.phiraName})` : ''}`);
    return { ok: true, binding };
  }

  unbind(platform, userId) {
    const key = `${platform}:${userId}`;
    const binding = this.bindings.get(key);
    if (!binding) return false;

    const beforeBindings = new Map(this.bindings);
    const beforeIndex = new Map(this.phiraIndex);
    this.bindings.delete(key);
    this.phiraIndex.delete(String(binding.phiraId));
    try {
      this.save();
    } catch (e) {
      this.bindings = beforeBindings;
      this.phiraIndex = beforeIndex;
      log.error(`login: failed to save bindings: ${e.message}`);
      return false;
    }

    log.info(`login: unbound ${key} (phira ${binding.phiraId})`);
    return true;
  }

  load() {
    let text;
    try {
      text = fs.readFileSync(this.bindingsFile, 'utf8');
    } catch {
      return;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      log.error(`login: invalid bindings file ${this.bindingsFile}: ${e.message}`);
      return;
    }

    const list = Array.isArray(data) ? data : Array.isArray(data.bindings) ? data.bindings : [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const platform = String(item.platform || '').trim();
      const userId = String(item.userId || '').trim();
      const phiraId = item.phiraId;
      if (!platform || !userId || phiraId === undefined || phiraId === null) continue;
      const key = `${platform}:${userId}`;
      const phiraKey = String(phiraId);
      if (this.phiraIndex.has(phiraKey) && this.phiraIndex.get(phiraKey) !== key) {
        log.warn(`login: duplicate phira id ${phiraKey} in bindings, keeping first`);
        continue;
      }
      const binding = {
        platform,
        userId,
        phiraId,
        phiraName: typeof item.phiraName === 'string' ? item.phiraName : '',
        phiraAvatar: item.phiraAvatar || null,
        boundAt: typeof item.boundAt === 'string' ? item.boundAt : new Date().toISOString(),
      };
      this.bindings.set(key, binding);
      this.phiraIndex.set(phiraKey, key);
    }
  }

  save() {
    const data = {
      version: 1,
      updatedAt: new Date().toISOString(),
      bindings: [...this.bindings.values()],
    };
    fs.mkdirSync(path.dirname(this.bindingsFile), { recursive: true });
    fs.writeFileSync(this.bindingsFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }
}

export async function handleLoginPage(state, req, res, url) {
  try {
    const manager = state.login;
    const clientIp =
      req.clientIp || resolveClientIp(req, state.config?.api?.trustedProxies);
    if (!manager) {
      sendHtml(res, 503, errorPage('服务不可用', '登录服务尚未初始化。'));
      return;
    }
    if (!manager.config.enabled) {
      sendHtml(res, 403, errorPage('登录功能未启用', '服务器已关闭 Phira 账号绑定。'));
      return;
    }

    const code = url.pathname.startsWith('/login/') ? url.pathname.slice('/login/'.length) : '';
    if (!CODE_PATTERN.test(code)) {
      sendHtml(res, 404, errorPage('页面不存在', '请从 QQ 获取完整的登录链接。'));
      return;
    }

    const session = manager.getSession(code);
    if (!session) {
      sendHtml(
        res,
        410,
        errorPage('链接无效或已过期', '请在 QQ 中重新发送登录指令，获取新的登录链接。'),
      );
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const html = formPage(session);
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(html),
        });
        res.end();
        return;
      }
      sendHtml(res, 200, html);
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'GET, POST', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return;
    }

    let email = '';
    let password = '';
    const body = await readBody(req);
    const contentType = String(req.headers['content-type'] || '');
    if (contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(body);
        email = String(parsed.email || '').trim();
        password = String(parsed.password || '');
      } catch {
        email = '';
        password = '';
      }
    } else {
      const params = new URLSearchParams(body);
      email = String(params.get('email') || '').trim();
      password = String(params.get('password') || '');
    }

    if (!email || !password) {
      sendHtml(res, 200, formPage(session, { error: '请输入邮箱和密码', email }));
      return;
    }
    if (email.length > 254 || password.length > 128) {
      sendHtml(res, 200, formPage(session, { error: '邮箱或密码长度不合法', email }));
      return;
    }

    const attempt = manager.takeAttempt(code, clientIp);
    if (!attempt.ok) {
      sendHtml(
        res,
        429,
        errorPage('尝试次数过多', '请在 QQ 中重新发送登录指令，获取新的登录链接。'),
      );
      return;
    }

    const result = await authenticatePhira(manager.config, email, password);
    if (!result.ok) {
      log.warn(
        `login: authentication failed for ${session.platform}:${session.userId} from ${clientIp}`,
      );
      sendHtml(res, 200, formPage(session, { error: result.error, email }));
      return;
    }

    const bound = manager.bind(session.platform, session.userId, result.phira);
    if (!bound.ok) {
      log.warn(
        `login: bind failed for ${session.platform}:${session.userId} from ${clientIp}: ${bound.error}`,
      );
      sendHtml(res, 200, formPage(session, { error: bound.error, email }));
      return;
    }

    manager.deleteSession(code);
    log.info(`login: bound ${session.platform}:${session.userId} from ${clientIp}`);
    sendHtml(res, 200, successPage(bound.binding));
  } catch (e) {
    log.error(`login: page error: ${e.stack || e.message}`);
    if (!res.headersSent) {
      sendHtml(res, 500, errorPage('服务器错误', '处理登录请求时出现错误，请稍后重试。'));
    } else {
      res.end();
    }
  }
}

/** 供 API 复用的校验函数。 */
export function normalizeLoginIdentity(platformValue, userIdValue) {
  const platform = String(platformValue ?? 'qq').trim().toLowerCase();
  const userId = String(userIdValue ?? '').trim();
  if (!/^[a-z0-9_-]{1,20}$/.test(platform)) return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) return null;
  return { platform, userId };
}
