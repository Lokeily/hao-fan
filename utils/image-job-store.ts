import type { ImageResult } from './vision.ts';

// 图片翻译任务存储。
// 之前把包含整张 base64 原图的 ImageResult 写入 storage.local，
// 而 storage.local 在 Firefox 只有 5MB、Chrome 也只有 10MB 配额；
// 一张 6MB 原图膨胀成约 8MB 字符串后写入必然失败，还会和翻译缓存抢配额。
// 改用 IndexedDB：配额宽松（通常数百 MB），足以承载大图任务。
const DB_NAME = 'haofan-image-jobs';
const STORE_NAME = 'jobs';
const DB_VERSION = 1;

// 任务结果是一次性消费的（读取即删除），但结果页可能从未被打开
// （用户关掉标签、标签创建失败等），此时任务会永久残留。
// 每次写入时顺带清理超过 24 小时的旧任务；无 createdAt 的旧数据视为过期。
const TTL_MS = 24 * 3600 * 1000;

type StoredJob = ImageResult & { createdAt?: number };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('无法打开图片任务数据库'));
  });
}

// 每次写入前清理过期任务，避免从未被打开的结果页长期占用存储。
async function sweepExpired(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const cursorReq = store.openCursor();
    const cutoff = Date.now() - TTL_MS;
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        const value = cursor.value as StoredJob | undefined;
        if (!value?.createdAt || value.createdAt < cutoff) cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('清理过期图片任务失败'));
  });
}

// 保存一次图片翻译任务结果（含可能数 MB 的 base64 原图）。
export async function putImageJob(id: string, result: ImageResult): Promise<void> {
  const db = await openDb();
  try {
    await sweepExpired(db);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ ...result, createdAt: Date.now() }, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('保存图片翻译任务失败'));
    });
  } finally {
    db.close();
  }
}

// 读取并一次性消费（读取后删除），避免任务结果长期占用存储。
export async function takeImageJob(id: string): Promise<ImageResult | null> {
  const db = await openDb();
  try {
    return await new Promise<ImageResult | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const value = getReq.result as StoredJob | undefined;
        store.delete(id);
        resolve(value ?? null);
      };
      getReq.onerror = () => reject(getReq.error ?? new Error('读取图片翻译任务失败'));
    });
  } finally {
    db.close();
  }
}
