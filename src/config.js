import fs from 'node:fs';

const CONFIG_FILE = 'server_config.yml';

const DEFAULT_CONFIG = {
  monitors: [2],
  announcements: [],
  showOnlineRooms: true,
  qqBot: {
    enabled: true,
    port: 3001,
    accessToken: '',
    adminQQ: [],
    groupIds: [],
    reportInterval: 300,
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

  return {
    monitors:
      monitors === null
        ? [...DEFAULT_CONFIG.monitors]
        : monitors.map(Number).filter((it) => Number.isInteger(it)),
    announcements: parseList(lines, 'announcements') ?? [],
    showOnlineRooms: parseBool(lines, 'show_online_rooms', true),
    qqBot: {
      enabled: parseBool(lines, 'enabled', DEFAULT_CONFIG.qqBot.enabled),
      port: parseNumber(lines, 'port', DEFAULT_CONFIG.qqBot.port),
      accessToken: parseString(lines, 'access_token', DEFAULT_CONFIG.qqBot.accessToken),
      adminQQ: parseNumberList(lines, 'admin_qq', DEFAULT_CONFIG.qqBot.adminQQ),
      groupIds: parseNumberList(lines, 'group_ids', DEFAULT_CONFIG.qqBot.groupIds),
      reportInterval: parseNumber(
        lines,
        'report_interval',
        DEFAULT_CONFIG.qqBot.reportInterval,
      ),
    },
  };
}
