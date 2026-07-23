import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { storage } from 'wxt/utils/storage';
import { configItem, usageItem } from '../utils/storage';
import { getProviderApiKey, normalizeConfig, type AppConfig } from '../utils/config';
import { getProvider } from '../utils/providers';
import { translateBatchDetailed, translateOneDetailed } from '../utils/translator';
import { translateImage, type ImageResult } from '../utils/vision';
import { ensureCacheLoaded } from '../utils/cache';
import { fetchWithTimeout } from '../utils/requester';
import { asRecord, readBatch, readJobId, readSingle } from '../utils/messages';
import { accumulateUsage, EMPTY_USAGE_TOTALS, type TranslationStats } from '../utils/usage';

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const translationJobs = new Map<string, Set<AbortController>>();
let usageWriteQueue: Promise<void> = Promise.resolve();

// 配置读取：每次都重新读取最新值，避免“刚在设置页改完 Key，测试连接却用了旧配置”的竞态。
// 仅在读取异常时退化使用上次缓存，保证 SW 异常也不会完全卡死。
let cfgCache: AppConfig | null = null;
try {
  configItem.watch((v) => {
    if (v) cfgCache = normalizeConfig(v);
  });
} catch {
  /* watch 不可用时退化为每次读取 */
}
async function getCfg(): Promise<AppConfig> {
  try {
    const v = await configItem.getValue();
    if (v) cfgCache = normalizeConfig(v);
  } catch {
    /* 读取失败时退化为上次缓存 */
  }
  if (!cfgCache) cfgCache = normalizeConfig(configItem.defaultValue);
  return cfgCache!;
}

// 启动即预热翻译缓存（只发生一次）
ensureCacheLoaded().catch(() => {});

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(bin)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTranslationJob<T>(
  jobId: string | undefined,
  task: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!jobId) return task();
  const controller = new AbortController();
  const controllers = translationJobs.get(jobId) || new Set<AbortController>();
  controllers.add(controller);
  translationJobs.set(jobId, controllers);
  try {
    return await task(controller.signal);
  } finally {
    controllers.delete(controller);
    if (controllers.size === 0) translationJobs.delete(jobId);
  }
}

function cancelTranslationJob(jobId: string): void {
  translationJobs.get(jobId)?.forEach((controller) => controller.abort());
  translationJobs.delete(jobId);
}

function recordUsage(stats: TranslationStats): Promise<void> {
  const write = usageWriteQueue.then(async () => {
    const current = await usageItem.getValue();
    await usageItem.setValue(accumulateUsage(current, stats));
  });
  usageWriteQueue = write.catch(() => {});
  return write.catch(() => {});
}

function resetUsage(): Promise<void> {
  const write = usageWriteQueue.then(() => usageItem.setValue({ ...EMPTY_USAGE_TOTALS }));
  usageWriteQueue = write.catch(() => {});
  return write;
}

function assertProviderReady(cfg: AppConfig): void {
  const provider = getProvider(cfg.provider);
  if (!provider) throw new Error('不支持的翻译引擎');
  if (!getProviderApiKey(cfg) && provider.needsKey) throw new Error('请先在设置页填写 API Key');
}

function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return Number.POSITIVE_INFINITY;
  const encoded = dataUrl.slice(comma + 1);
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return Math.floor((encoded.length * 3) / 4) - padding;
}

function validateDataUrl(dataUrl: string): void {
  if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl)) {
    throw new Error('图片数据格式无效');
  }
  if (estimateDataUrlBytes(dataUrl) > MAX_IMAGE_BYTES) {
    throw new Error('图片不能超过 6 MB');
  }
}

function respond(
  task: () => Promise<Record<string, unknown>>,
  sendResponse: (response?: unknown) => void,
): true {
  task().then(
    (data) => sendResponse({ ok: true, ...data }),
    (error) => sendResponse({ ok: false, error: errorMessage(error) }),
  );
  return true;
}

// 统一取图 → 调视觉模型翻译，返回结果（API 调用放在后台，规避 CORS）。
async function doTranslateImage(srcUrl?: string, dataUrl?: string): Promise<ImageResult> {
  let img = dataUrl;
  if (!img && srcUrl) {
    const res = await fetchWithTimeout(srcUrl, undefined, 20_000);
    if (!res.ok) throw new Error('图片下载失败');
    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength > MAX_IMAGE_BYTES) throw new Error('图片不能超过 6 MB');
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) throw new Error('目标地址返回的不是图片');
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('图片不能超过 6 MB');
    img = await blobToDataUrl(blob);
  }
  if (!img) throw new Error('未提供图片');
  validateDataUrl(img);
  const cfg = await getCfg();
  assertProviderReady(cfg);
  return translateImage(cfg, img);
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((rawMessage: unknown, _sender, sendResponse) => {
    const message = asRecord(rawMessage);
    if (!message || typeof message.type !== 'string') return false;

    if (message.type === 'CANCEL_TRANSLATION') {
      const jobId = readJobId(message);
      if (jobId) cancelTranslationJob(jobId);
      return false;
    }

    if (message.type === 'GET_USAGE_STATS') {
      return respond(async () => ({ stats: await usageItem.getValue() }), sendResponse);
    }

    if (message.type === 'RESET_USAGE_STATS') {
      return respond(async () => {
        await resetUsage();
        return { stats: { ...EMPTY_USAGE_TOTALS } };
      }, sendResponse);
    }

    if (message.type === 'TRANSLATE_BATCH') {
      return respond(async () => {
        const texts = readBatch(message);
        const jobId = readJobId(message);
        return withTranslationJob(jobId, async (signal) => {
          const cfg = await getCfg();
          assertProviderReady(cfg);
          const result = await translateBatchDetailed(cfg, texts, signal);
          // 等待统计持久化，避免 MV3 service worker 在响应后被回收而丢失本批数据。
          await recordUsage(result.stats);
          return { translations: result.translations, stats: result.stats };
        });
      }, sendResponse);
    }

    if (message.type === 'TRANSLATE_ONE') {
      return respond(async () => {
        const text = readSingle(message);
        const cfg = await getCfg();
        assertProviderReady(cfg);
        const result = await translateOneDetailed(cfg, text);
        await recordUsage(result.stats);
        return { translation: result.translation, stats: result.stats };
      }, sendResponse);
    }

    if (message.type === 'TRANSLATE_IMAGE') {
      return respond(async () => {
        const payload = asRecord(message.payload);
        const srcUrl = typeof payload?.srcUrl === 'string' ? payload.srcUrl : undefined;
        const dataUrl = typeof payload?.dataUrl === 'string' ? payload.dataUrl : undefined;
        const result = await doTranslateImage(srcUrl, dataUrl);
        // 弹窗上传的图片没有网页中的图元素可锚定，仍用结果页展示。
        const id = crypto.randomUUID();
        await storage.setItem(`local:imageJob:${id}`, result);
        await browser.tabs.create({
          url: browser.runtime.getURL(`/image-translate.html?job=${id}`),
        });
        return {};
      }, sendResponse);
    }

  });

  // MV3 下 service worker 可能被回收重建，菜单会残留，先清空再建避免 duplicate id 报错
  browser.contextMenus?.removeAll(() => {
    browser.contextMenus?.create({
      id: 'ot-translate-page',
      title: '翻译本页（好翻）',
      contexts: ['page'],
    });
    browser.contextMenus?.create({
      id: 'ot-translate-image',
      title: '翻译图片（好翻）',
      contexts: ['image'],
    });
    browser.contextMenus?.create({
      id: 'ot-translate-selection',
      title: '翻译选中内容（好翻）',
      contexts: ['selection'],
    });
  });
  // 右击时若内容脚本尚未注入（如页面在装扩展前就打开、未刷新），先按需注入，确保悬浮按钮出现且指令可达
  async function ensureContent(tabId: number) {
    try {
      await browser.scripting?.executeScript({
        target: { tabId },
        files: ['/content-scripts/content.js'],
      });
    } catch {
      /* 受限页面（PDF / 浏览器内部页）注入会失败，忽略，由调用方给出提示 */
    }
  }

  browser.contextMenus?.onClicked.addListener((info, tab) => {
    if (!tab?.id) return;
    if (info.menuItemId === 'ot-translate-page') {
      ensureContent(tab.id).then(() =>
        browser.tabs.sendMessage(tab.id!, { type: 'TRANSLATE_PAGE' }).catch(() => {}),
      );
    } else if (info.menuItemId === 'ot-translate-image' && info.srcUrl) {
      // 右键图片：在后台翻译，再把结果发回内容脚本，在原网页图片旁悬浮展示
      ensureContent(tab.id)
        .then(() => doTranslateImage(info.srcUrl))
        .then((result) =>
          browser.tabs.sendMessage(tab.id!, {
            type: 'SHOW_IMAGE_RESULT',
            // 页面只需要坐标和译文，不重复传输可能数 MB 的 base64 原图。
            payload: { srcUrl: info.srcUrl, result: { segments: result.segments } },
          }),
        )
        .catch((error) => {
          console.error('好翻图片翻译失败', error);
          browser.tabs.sendMessage(tab.id!, {
            type: 'SHOW_ERROR',
            payload: { message: errorMessage(error) },
          }).catch(() => {});
        });
    } else if (info.menuItemId === 'ot-translate-selection') {
      ensureContent(tab.id).then(() =>
        browser.tabs.sendMessage(tab.id!, { type: 'TRANSLATE_SELECTION' }).catch(() => {}),
      );
    }
  });
});
