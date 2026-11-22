import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCALES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'locales');
const cache = new Map();

function load(lang) {
  if (cache.has(lang)) return cache.get(lang);
  let table = {};
  try {
    table = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${lang}.json`), 'utf8'));
  } catch {
    table = {};
  }
  cache.set(lang, table);
  return table;
}

/** 把接口返回的 language 字段归一到受支持的语言。 */
export function normalizeLang(raw) {
  const value = String(raw ?? '').toLowerCase();
  if (value.includes('zh')) {
    if (
      value.includes('tw') ||
      value.includes('hk') ||
      value.includes('mo') ||
      value.includes('hant')
    ) {
      return 'zh-TW';
    }
    return 'zh-CN';
  }
  return 'en-US';
}

export function t(lang, key) {
  const table = load(lang);
  if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
  const fallback = load('en-US');
  return Object.prototype.hasOwnProperty.call(fallback, key) ? fallback[key] : key;
}
