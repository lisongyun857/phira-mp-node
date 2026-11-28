import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { log } from './logger.js';

/** 单谱上限 50MB */
export const MAX_CHART_BYTES = 50 * 1024 * 1024;
/** 上传后固定保留 3 天 */
const TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** 每小时清理一次过期谱面 */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const HASH_RE = /^[a-f0-9]{64}$/;

const STORE_DIR = path.resolve('local-charts');

let cleanupTimer = null;

function chartDir(hash) {
  return path.join(STORE_DIR, hash);
}

export function chartFilePath(hash) {
  return path.join(chartDir(hash), 'chart.zip');
}

function metaPath(hash) {
  return path.join(chartDir(hash), 'meta.json');
}

export function isValidHash(hash) {
  return typeof hash === 'string' && HASH_RE.test(hash);
}

/** 初始化存储目录与定时清理；幂等 */
export function initLocalCharts() {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  cleanExpiredCharts();
  if (!cleanupTimer) {
    cleanupTimer = setInterval(() => {
      try {
        cleanExpiredCharts();
      } catch (e) {
        log.warn(`local-charts: cleanup failed: ${e.message}`);
      }
    }, CLEANUP_INTERVAL_MS);
    cleanupTimer.unref?.();
  }
  return STORE_DIR;
}

/** 读取原始二进制请求体，超过 limit 抛 413 */
export function readRawBody(req, limit = MAX_CHART_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      const error = new Error(`请求体超过 ${Math.floor(limit / 1024 / 1024)}MB 限制`);
      error.status = 413;
      reject(error);
      req.resume();
      return;
    }

    const chunks = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        const error = new Error(`请求体超过 ${Math.floor(limit / 1024 / 1024)}MB 限制`);
        error.status = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

/**
 * 保存谱面 zip。相同内容（SHA-256 相同）视为同一谱面：覆盖并刷新过期时间。
 */
export function saveChart(buffer, { name, uploaderId, roomId }) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const now = Date.now();
  const meta = {
    hash,
    name: String(name ?? '').trim() || `本地谱面 ${hash.slice(0, 8)}`,
    size: buffer.length,
    uploaderId,
    roomId: String(roomId ?? ''),
    createdAt: now,
    expiresAt: now + TTL_MS,
  };

  const dir = chartDir(hash);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(chartFilePath(hash), buffer);
  fs.writeFileSync(metaPath(hash), JSON.stringify(meta));
  log.info(
    `local-charts: saved ${hash} (${meta.size} bytes, room ${meta.roomId}, uploader ${uploaderId})`,
  );
  return meta;
}

/** 读取未过期的谱面元信息；不存在或已过期返回 null */
export function findChart(hash) {
  if (!isValidHash(hash)) return null;
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath(hash), 'utf8'));
  } catch {
    return null;
  }
  if (!meta || !Number.isFinite(meta.expiresAt) || meta.expiresAt <= Date.now()) {
    removeChart(hash);
    return null;
  }
  if (!fs.existsSync(chartFilePath(hash))) {
    removeChart(hash);
    return null;
  }
  return meta;
}

export function removeChart(hash) {
  if (!isValidHash(hash)) return false;
  try {
    fs.rmSync(chartDir(hash), { recursive: true, force: true });
    return true;
  } catch (e) {
    log.warn(`local-charts: failed to remove ${hash}: ${e.message}`);
    return false;
  }
}

/** 删除所有过期谱面，返回删除数量 */
export function cleanExpiredCharts(now = Date.now()) {
  let entries;
  try {
    entries = fs.readdirSync(STORE_DIR, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const hash = entry.name;
    if (!isValidHash(hash)) continue;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath(hash), 'utf8'));
    } catch {
      meta = null;
    }
    const expired = meta ? Number(meta.expiresAt) <= now : true;
    if (!expired) continue;
    try {
      fs.rmSync(chartDir(hash), { recursive: true, force: true });
      removed += 1;
    } catch (e) {
      log.warn(`local-charts: failed to remove expired ${hash}: ${e.message}`);
    }
  }
  if (removed > 0) log.info(`local-charts: cleaned ${removed} expired chart(s)`);
  return removed;
}

/** 以流式方式返回谱面 zip */
export function serveChart(req, res, hash) {
  const meta = findChart(hash);
  if (!meta) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: '谱面不存在或已过期' }));
    return;
  }
  const file = chartFilePath(hash);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: '谱面不存在或已过期' }));
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': stat.size,
    'Cache-Control': 'private, max-age=600',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file);
  stream.on('error', (e) => {
    log.warn(`local-charts: stream ${hash} failed: ${e.message}`);
    res.destroy();
  });
  req.on('close', () => stream.destroy());
  stream.pipe(res);
}
