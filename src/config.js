import fs from 'node:fs';

const CONFIG_FILE = 'server_config.yml';
const RUNTIME_FILE = 'runtime-config.json';

const DEFAULT_CONFIG = {
  monitors: [2],
  announcements: [],
  showOnlineRooms: true,
  allowClientCreateRoom: true,
  qqBot: {
    enabled: true,
    port: 3001,
    accessToken: '',
    adminQQ: [],
    groupIds: [],
    reportInterval: 300,
  },
  api: {
    enabled: true,
    host: '127.0.0.1',
    port: 3052,
    accessToken: '',
    adminPassword: '',
    protectedPaths: [],
    publicPaths: [],
    trustedProxies: ['127.0.0.1', '::1'],
    allowedOrigins: ['*'],
  },
  login: {
    enabled: true,
    publicUrl: '',
    linkTtl: 600,
    maxAttempts: 5,
    bindingsFile: 'data/bindings.json',
    clientVersion: '0.6.7',
    clientFlavor: 'none',
  },
};

function stripComment(value) {
  let quote = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || value[i - 1] === ' ')) {
      return value.slice(0, i);
    }
  }
  return value;
}

function stripQuotes(value) {
  const v = stripComment(value).trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
}

function splitInline(text) {
  const parts = [];
  let current = '';
  let quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ',') {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function findKey(lines, key) {
  const pattern = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`);
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(pattern);
    if (match) return { index: i, rest: match[1] };
  }
  return null;
}

/** 取出某个顶层配置段（缩进在其下的所有行），用于避免不同段中的同名键互相干扰。 */
function sectionLines(lines, sectionName) {
  const pattern = new RegExp(`^(\\s*)${sectionName}\\s*:`);
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(pattern);
    if (!match) continue;

    const baseIndent = match[1].length;
    const result = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (!line.trim()) {
        result.push(line);
        continue;
      }
      const indent = line.match(/^(\s*)/)[1].length;
      if (indent <= baseIndent) break;
      result.push(line);
    }
    return result;
  }
  return [];
}

/** 读取列表型配置，未配置时返回 null。 */
function parseList(lines, key) {
  const found = findKey(lines, key);
  if (!found) return null;

  const rest = stripComment(found.rest).trim();
  if (rest.startsWith('[')) {
    const inner = rest.replace(/^\[/, '').replace(/\]$/, '');
    if (!inner.trim()) return [];
    return splitInline(inner)
      .map((it) => it.trim())
      .filter(Boolean);
  }

  const items = [];
  for (let i = found.index + 1; i < lines.length; i += 1) {
    const match = lines[i].match(/^\s*-\s*(.*)$/);
    if (!match) break;
    const item = stripQuotes(match[1]);
    if (item) items.push(item);
  }
  return items;
}

function parseBool(lines, key, fallback) {
  const found = findKey(lines, key);
  if (!found) return fallback;
  const value = stripComment(found.rest).trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function parseString(lines, key, fallback) {
  const found = findKey(lines, key);
  if (!found) return fallback;
  return stripQuotes(found.rest);
}

function parseNumber(lines, key, fallback) {
  const found = findKey(lines, key);
  if (!found) return fallback;
  const value = Number(stripComment(found.rest).trim());
  return Number.isFinite(value) ? value : fallback;
}

function parseNumberList(lines, key, fallback) {
  const items = parseList(lines, key);
  if (items === null) return fallback;
  return items.map(Number).filter((it) => Number.isInteger(it));
}

/** 与 Rust 版本一致：读取失败时使用默认配置 { monitors: [2] }。 */
export function loadConfig() {
  let text;
  try {
    text = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch {
    return { ...DEFAULT_CONFIG, monitors: [...DEFAULT_CONFIG.monitors] };
  }

  const lines = text.split(/\r?\n/);
  const monitors = parseList(lines, 'monitors');
  const qqBotLines = sectionLines(lines, 'qq_bot');
  const apiLines = sectionLines(lines, 'api');
  const loginLines = sectionLines(lines, 'login');

  const config = {
    monitors:
      monitors === null
        ? [...DEFAULT_CONFIG.monitors]
        : monitors.map(Number).filter((it) => Number.isInteger(it)),
    announcements: parseList(lines, 'announcements') ?? [],
    showOnlineRooms: parseBool(lines, 'show_online_rooms', true),
    allowClientCreateRoom: parseBool(
      lines,
      'allow_client_create_room',
      DEFAULT_CONFIG.allowClientCreateRoom,
    ),
    qqBot: {
      enabled: parseBool(qqBotLines, 'enabled', DEFAULT_CONFIG.qqBot.enabled),
      port: parseNumber(qqBotLines, 'port', DEFAULT_CONFIG.qqBot.port),
      accessToken: parseString(
        qqBotLines,
        'access_token',
        DEFAULT_CONFIG.qqBot.accessToken,
      ),
      adminQQ: parseNumberList(qqBotLines, 'admin_qq', DEFAULT_CONFIG.qqBot.adminQQ),
      groupIds: parseNumberList(qqBotLines, 'group_ids', DEFAULT_CONFIG.qqBot.groupIds),
      reportInterval: parseNumber(
        qqBotLines,
        'report_interval',
        DEFAULT_CONFIG.qqBot.reportInterval,
      ),
    },
    api: {
      enabled: parseBool(apiLines, 'enabled', DEFAULT_CONFIG.api.enabled),
      host: parseString(apiLines, 'host', DEFAULT_CONFIG.api.host),
      port: parseNumber(apiLines, 'port', DEFAULT_CONFIG.api.port),
      accessToken: parseString(apiLines, 'access_token', DEFAULT_CONFIG.api.accessToken),
      // 管理面板密码；为空时管理端退化为仅用 access_token
      adminPassword: parseString(
        apiLines,
        'admin_password',
        DEFAULT_CONFIG.api.adminPassword,
      ),
      // 需要校验 token 的接口；为空时全部公开
      protectedPaths: parseList(apiLines, 'protected_paths') ?? [],
      // 优先级更高的公开接口，可覆盖 protected_paths
      publicPaths: parseList(apiLines, 'public_paths') ?? [],
      // 受信任的反向代理地址，只有来自这些地址的 X-Forwarded-For / X-Real-IP 才会被采信
      trustedProxies:
        parseList(apiLines, 'trusted_proxies') ?? [...DEFAULT_CONFIG.api.trustedProxies],
      // 允许跨域访问的前端来源，* 表示允许任意来源
      allowedOrigins: parseList(apiLines, 'allowed_origins') ?? [...DEFAULT_CONFIG.api.allowedOrigins],
    },
    login: {
      enabled: parseBool(loginLines, 'enabled', DEFAULT_CONFIG.login.enabled),
      publicUrl: parseString(loginLines, 'public_url', DEFAULT_CONFIG.login.publicUrl),
      linkTtl: parseNumber(loginLines, 'link_ttl', DEFAULT_CONFIG.login.linkTtl),
      maxAttempts: parseNumber(
        loginLines,
        'max_attempts',
        DEFAULT_CONFIG.login.maxAttempts,
      ),
      bindingsFile: parseString(
        loginLines,
        'bindings_file',
        DEFAULT_CONFIG.login.bindingsFile,
      ),
      clientVersion: parseString(
        loginLines,
        'client_version',
        DEFAULT_CONFIG.login.clientVersion,
      ),
      clientFlavor: parseString(
        loginLines,
        'client_flavor',
        DEFAULT_CONFIG.login.clientFlavor,
      ),
    },
  };

  applyRuntimeOverrides(config);
  return config;
}

/** 运行时覆盖配置（管理面板修改后写入 runtime-config.json） */
function loadRuntimeOverrides() {
  try {
    const raw = fs.readFileSync(RUNTIME_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function applyRuntimeOverrides(config) {
  const overrides = loadRuntimeOverrides();
  const api = overrides && overrides.api;
  if (!api || typeof api !== 'object') return;

  if (typeof api.adminPassword === 'string') config.api.adminPassword = api.adminPassword;
  if (typeof api.accessToken === 'string') config.api.accessToken = api.accessToken;
  if (Array.isArray(api.allowedOrigins)) {
    config.api.allowedOrigins = api.allowedOrigins.filter((item) => typeof item === 'string');
  }
}

/** 合并写入运行时配置，返回完整覆盖内容。 */
export function saveRuntimeOverrides(partial) {
  const current = loadRuntimeOverrides();
  const next = {
    ...current,
    ...partial,
    api: { ...(current.api || {}), ...((partial && partial.api) || {}) },
  };
  fs.writeFileSync(RUNTIME_FILE, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

