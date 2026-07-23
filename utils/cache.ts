import { storage } from 'wxt/utils/storage';

// 翻译结果缓存：相同文本 + 目标语言 + 模型(+提示词) 直接命中，避免重复消耗 Token 与网络往返。
// 内存为主、防抖回写；每条带时间戳，过期自动失效（TTL）。
type Entry = { v: string; t: number };
const cacheItem = storage.defineItem<Record<string, Entry>>('local:translateCache', {
  defaultValue: {},
});

const TTL = 30 * 24 * 3600 * 1000; // 30 天

let memory: Record<string, Entry> | null = null;
let loadPromise: Promise<void> | null = null;
let dirty = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function hash(s: string): string {
  // 两个独立的 32 位散列显著降低误命中概率，同时避免把长原文直接作为 storage 键。
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x85ebca6b);
  }
  return `c${(h1 >>> 0).toString(36)}-${(h2 >>> 0).toString(36)}`;
}

// 注意：调用方传入的 model 已包含 provider|model|systemPrompt（见 translator.cacheKeyOf），
// 因此提示词变更会改变键，避免命中旧提示词产生的错误译文。
function keyOf(text: string, target: string, model: string): string {
  return hash(`${model}|${target}|${text}`);
}

// 启动时 / 首次翻译前把缓存载入内存（只发生一次）
export async function ensureCacheLoaded(): Promise<void> {
  if (memory !== null) return;
  if (!loadPromise) {
    loadPromise = cacheItem
      .getValue()
      .then((value) => {
        if (memory === null) memory = value;
      })
      .catch((error) => {
        loadPromise = null;
        throw error;
      });
  }
  await loadPromise;
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    const snap = memory;
    if (!snap || !dirty) return;
    dirty = false;
    const now = Date.now();
    // 过期清理 + 总量上限（LRU 近似：超量时丢弃最早写入）
    let keys = Object.keys(snap);
    for (const k of keys) {
      if (now - snap[k].t > TTL) delete snap[k];
    }
    keys = Object.keys(snap);
    if (keys.length > 2000) {
      const sorted = keys
        .map((k) => ({ k, t: snap[k].t }))
        .sort((a, b) => a.t - b.t)
        .slice(0, keys.length - 2000);
      for (const x of sorted) delete snap[x.k];
    }
    try {
      await cacheItem.setValue({ ...snap });
    } catch {
      // 保留脏状态，等待下一次写入时重试；避免异步定时器产生未处理拒绝。
      dirty = true;
    }
  }, 400);
}

// 同步读取（已在内存中，零往返）；过期返回 null
export function getCachedSync(text: string, target: string, model: string): string | null {
  if (memory === null) return null;
  const e = memory[keyOf(text, target, model)];
  if (!e) return null;
  if (Date.now() - e.t > TTL) {
    delete memory[keyOf(text, target, model)];
    dirty = true;
    schedulePersist();
    return null;
  }
  return e.v;
}

// 同步写入（仅改内存 + 标记脏，回写交给防抖定时器合并为一次）
export function setCachedSync(text: string, target: string, model: string, translation: string): void {
  if (memory === null) return;
  memory[keyOf(text, target, model)] = { v: translation, t: Date.now() };
  dirty = true;
  schedulePersist();
}

// 保留旧异步签名以兼容划词气泡等调用
export async function getCached(text: string, target: string, model: string): Promise<string | null> {
  await ensureCacheLoaded();
  return getCachedSync(text, target, model);
}

export async function setCached(
  text: string,
  target: string,
  model: string,
  translation: string,
): Promise<void> {
  await ensureCacheLoaded();
  setCachedSync(text, target, model, translation);
}
