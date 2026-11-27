/**
 * 解析真实客户端 IP。
 * 反向代理（Nginx 等）会把客户端 IP 放在 X-Forwarded-For / X-Real-IP 中；
 * 只有请求来自受信任的代理地址时才采信这些头，避免公网直连伪造 IP。
 */

const DEFAULT_TRUSTED_PROXIES = ['127.0.0.1', '::1'];

function normalizeIp(value) {
  if (!value) return '';
  let ip = String(value).trim();
  // IPv4-mapped IPv6，例如 ::ffff:127.0.0.1
  if (ip.startsWith('::ffff:')) ip = ip.slice('::ffff:'.length);
  // 去掉端口（部分代理会写成 1.2.3.4:5678）
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  if (/^\[[^\]]+\]$/.test(ip)) ip = ip.slice(1, -1);
  return ip;
}

function isTrustedProxy(ip, trustedProxies) {
  const value = normalizeIp(ip);
  return trustedProxies.some((entry) => normalizeIp(entry) === value);
}

function remoteAddressOf(req) {
  return req.socket?.remoteAddress || req.connection?.remoteAddress || '';
}

/**
 * 返回请求的真实客户端 IP。
 * - 直连：直接使用 socket 地址；
 * - 经过受信任代理：从 X-Forwarded-For 右侧向前跳过受信任代理，取第一个非代理地址；
 * - 其次尝试 X-Real-IP。
 */
export function resolveClientIp(req, trustedProxies = DEFAULT_TRUSTED_PROXIES) {
  const trusted = Array.isArray(trustedProxies) ? trustedProxies : DEFAULT_TRUSTED_PROXIES;
  const remote = normalizeIp(remoteAddressOf(req));
  if (!isTrustedProxy(remote, trusted)) return remote;

  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const chain = String(forwarded)
      .split(',')
      .map((item) => normalizeIp(item))
      .filter(Boolean);
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      if (!isTrustedProxy(chain[i], trusted)) return chain[i];
    }
    if (chain.length > 0) return chain[0];
  }

  const realIp = normalizeIp(req.headers['x-real-ip']);
  if (realIp) return realIp;

  return remote;
}

export { DEFAULT_TRUSTED_PROXIES };
