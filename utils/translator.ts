import { getProviderApiKey, type AppConfig } from './config';
import { getProvider } from './providers';
import { langCode } from './languages';
import { ensureCacheLoaded, getCachedSync, setCachedSync } from './cache';
import { fetchWithTimeout, postJson, cleanSecret } from './requester';
import { batchInstruction, createBatchItems, parseBatchTranslations } from './batch-protocol';
import { localSkipReason } from './language-detection';
import { createStats, estimateTokens, type TranslationStats } from './usage';
import { splitLongText } from './chunking';
import {
  parseCustomGlossary,
  matchExact,
  relevantTerms,
  buildGlossaryBlock,
  type TermMap,
} from './glossary';

// 翻译风格 → 追加到系统提示词的一句风格指令，让译文贴合场景（质量目标）。
const TONE_HINTS: Record<string, string> = {
  自然流畅: '译文要地道自然、通顺流畅，符合目标语言母语者的日常表达习惯。',
  正式书面: '译文采用正式、严谨的书面语，用词规范得体，适合正式文档或商务场景。',
  轻松口语: '译文采用轻松、口语化的表达，亲切自然，就像朋友间的日常对话。',
  简洁精炼: '译文力求简洁精炼，去除冗余，用最凝练的语言准确传达原意。',
};
const CACHE_PROTOCOL_VERSION = 'v0.1.1';
const MAX_BATCH_RECOVERY_REQUESTS = 2;

// ★ 质量核心：面向「接近人工翻译」的系统提示词。
// 强调：忠实语义 + 地道自然（反翻译腔）+ 语境/文化适配 + 专有名词保护 + 纯净输出。
function defaultSystem(target: string, source: string, tone?: string): string {
  const src = source && source !== '自动检测' ? `将${source}原文` : '自动识别源语言并';
  const toneHint = (tone && TONE_HINTS[tone]) || TONE_HINTS['自然流畅'];
  return [
    `你是专业翻译。请${src}翻译成${target}。`,
    `忠实保留完整含义、语气、专名、代码、URL、占位符与原有格式，不增删信息。`,
    `${toneHint}可按${target}习惯调整语序，避免机械直译。`,
    `只输出译文；已经是${target}或无需翻译的内容原样返回。`,
  ].join('\n');
}

export function cacheKeyOf(cfg: AppConfig): string {
  // 所有会影响译文的配置都必须参与缓存键，避免配置变化后命中旧译文。
  return [
    CACHE_PROTOCOL_VERSION,
    cfg.provider,
    (cfg.baseUrl || '').trim().replace(/\/+$/, ''),
    cfg.model,
    cfg.sourceLang,
    cfg.tone || '',
    cfg.systemPrompt || '',
    cfg.glossaryEnabled === false ? 'glossary:off' : cfg.customGlossary || 'glossary:default',
  ].join('|');
}

// 读取当前配置下的用户自定义术语表（解析一次）。
function customGlossaryOf(cfg: AppConfig): TermMap {
  return cfg.glossaryEnabled === false ? {} : parseCustomGlossary(cfg.customGlossary);
}

export interface TranslationResult {
  translation: string;
  stats: TranslationStats;
}

export interface TranslationBatchResult {
  translations: string[];
  stats: TranslationStats;
}

interface ChatResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
}

class TruncatedOutputError extends Error {
  readonly promptTokens: number;
  readonly completionTokens: number;

  constructor(promptTokens = 0, completionTokens = 0) {
    super('模型输出达到长度上限，正在拆分批次重试');
    this.name = 'TruncatedOutputError';
    this.promptTokens = promptTokens;
    this.completionTokens = completionTokens;
  }
}

function countSaved(stats: TranslationStats, text: string): void {
  stats.estimatedTokensSaved += estimateTokens(text);
}

function addChatUsage(stats: TranslationStats, result: ChatResult): void {
  stats.requests++;
  stats.promptTokens += result.promptTokens;
  stats.completionTokens += result.completionTokens;
}

// 单条翻译（按引擎类型分发）
export async function translateOneDetailed(
  cfg: AppConfig,
  text: string,
  signal?: AbortSignal,
): Promise<TranslationResult> {
  signal?.throwIfAborted();
  const t = text.trim();
  const stats = createStats(t ? 1 : 0);
  if (!t) return { translation: '', stats };
  await ensureCacheLoaded();
  const provider = getProvider(cfg.provider);
  if (!provider) throw new Error('不支持的翻译引擎');
  const ck = cacheKeyOf(cfg);
  const glossary = customGlossaryOf(cfg);

  if (localSkipReason(t, cfg.targetLang, cfg.sourceLang)) {
    stats.localSkipped++;
    countSaved(stats, t);
    return { translation: t, stats };
  }

  // 缓存命中（精确 TM）→ 0 Token 返回
  if (cfg.cacheEnabled) {
    const hit = getCachedSync(t, cfg.targetLang, ck);
    if (hit !== null) {
      stats.cacheHits++;
      countSaved(stats, t);
      return { translation: hit, stats };
    }
  }
  // ★ 术语库整条命中 → 0 Token 返回（预置资料库省 Token 的核心）
  if (cfg.glossaryEnabled !== false) {
    const term = matchExact(t, cfg.targetLang, glossary);
    if (term !== null) {
      if (cfg.cacheEnabled) setCachedSync(t, cfg.targetLang, ck, term);
      stats.glossaryHits++;
      countSaved(stats, t);
      return { translation: term, stats };
    }
  }

  stats.sentSegments = 1;
  stats.sentCharacters = t.length;
  if (provider?.type === 'mt') {
    stats.requests++;
    const out = await translateMT(provider.id, t, cfg, signal);
    if (cfg.cacheEnabled) setCachedSync(t, cfg.targetLang, ck, out);
    return { translation: out, stats };
  }
  // 默认走 LLM：注入本句相关术语，保证译法一致
  const block =
    cfg.glossaryEnabled !== false
      ? buildGlossaryBlock(relevantTerms([t], cfg.targetLang, glossary))
      : '';
  const response = await callChat(cfg, t, undefined, block, signal);
  addChatUsage(stats, response);
  if (cfg.cacheEnabled) setCachedSync(t, cfg.targetLang, ck, response.text);
  return { translation: response.text, stats };
}

export async function translateOne(cfg: AppConfig, text: string, signal?: AbortSignal): Promise<string> {
  return (await translateOneDetailed(cfg, text, signal)).translation;
}

// 批量翻译：LLM 合并一次请求省 Token；MT 逐条调用。
// 缓存改为内存同步读写（见 utils/cache.ts），避免整页翻译时每条都做 storage 往返。
export async function translateBatchDetailed(
  cfg: AppConfig,
  texts: string[],
  signal?: AbortSignal,
): Promise<TranslationBatchResult> {
  signal?.throwIfAborted();
  await ensureCacheLoaded();
  const stats = createStats(texts.length);
  const ck = cacheKeyOf(cfg);
  const provider = getProvider(cfg.provider);
  if (!provider) throw new Error('不支持的翻译引擎');
  const glossary = customGlossaryOf(cfg);
  const useGlossary = cfg.glossaryEnabled !== false;

  const result: string[] = new Array(texts.length);
  const pendingByText = new Map<string, { indexes: number[]; text: string }>();
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i].trim();
    if (!t) {
      result[i] = '';
      continue;
    }
    if (localSkipReason(t, cfg.targetLang, cfg.sourceLang)) {
      result[i] = t;
      stats.localSkipped++;
      countSaved(stats, t);
      continue;
    }
    // ① 精确 TM 缓存命中
    if (cfg.cacheEnabled) {
      const hit = getCachedSync(t, cfg.targetLang, ck);
      if (hit !== null) {
        result[i] = hit;
        stats.cacheHits++;
        countSaved(stats, t);
        continue;
      }
    }
    // ② 术语库整条命中 → 0 Token（不进入 LLM 请求）
    if (useGlossary) {
      const term = matchExact(t, cfg.targetLang, glossary);
      if (term !== null) {
        result[i] = term;
        stats.glossaryHits++;
        countSaved(stats, t);
        if (cfg.cacheEnabled) setCachedSync(t, cfg.targetLang, ck, term);
        continue;
      }
    }
    const pending = pendingByText.get(t);
    if (pending) {
      pending.indexes.push(i);
      stats.duplicateHits++;
      countSaved(stats, t);
    }
    else pendingByText.set(t, { indexes: [i], text: t });
  }
  const toTranslate = Array.from(pendingByText.values());
  if (toTranslate.length === 0) return { translations: result, stats };

  stats.sentSegments = toTranslate.length;
  stats.sentCharacters = toTranslate.reduce((sum, item) => sum + item.text.length, 0);

  if (provider.type === 'mt') {
    const batch = await translateMTBatch(provider.id, toTranslate.map((item) => item.text), cfg, signal);
    stats.requests += batch.requests;
    toTranslate.forEach((item, itemIndex) => {
      const translation = batch.translations[itemIndex] || item.text;
      item.indexes.forEach((index) => (result[index] = translation));
      if (cfg.cacheEnabled) setCachedSync(item.text, cfg.targetLang, ck, translation);
    });
    return { translations: result, stats };
  }

  const applyResult = (item: (typeof toTranslate)[number], translation: string) => {
    const tr = translation.trim() || item.text;
    item.indexes.forEach((index) => (result[index] = tr));
    if (cfg.cacheEnabled) setCachedSync(item.text, cfg.targetLang, ck, tr);
  };

  const translateLongItem = async (item: (typeof toTranslate)[number]) => {
    const parts = splitLongText(item.text);
    if (parts.length < 2) throw new Error('模型输出不完整，请减小翻译批次或提高模型输出上限');
    const translated = new Array<string>(parts.length);
    let next = 0;
    const worker = async () => {
      while (next < parts.length) {
        const index = next++;
        signal?.throwIfAborted();
        const block = useGlossary
          ? buildGlossaryBlock(relevantTerms([parts[index]], cfg.targetLang, glossary))
          : '';
        const response = await callChat(cfg, parts[index], undefined, block, signal);
        addChatUsage(stats, response);
        translated[index] = response.text;
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, parts.length) }, () => worker()));
    const compactTarget = cfg.targetLang === '中文' || cfg.targetLang === '日语' || cfg.targetLang === '韩语';
    applyResult(item, translated.join(item.text.includes('\n') ? '\n' : compactTarget ? '' : ' '));
  };

  let recoveryRequests = 0;
  const translateGroup = async (items: typeof toTranslate, recovery = false): Promise<void> => {
    signal?.throwIfAborted();
    const block = useGlossary
      ? buildGlossaryBlock(relevantTerms(items.map((item) => item.text), cfg.targetLang, glossary))
      : '';
    const input = JSON.stringify({ items: createBatchItems(items.map((item) => item.text)) });
    let response: ChatResult;
    try {
      response = await callChat(cfg, input, batchInstruction(cfg.targetLang), block, signal);
      addChatUsage(stats, response);
    } catch (error) {
      if (!(error instanceof TruncatedOutputError)) throw error;
      stats.requests++;
      stats.promptTokens += error.promptTokens;
      stats.completionTokens += error.completionTokens;
      if (items.length === 1) {
        await translateLongItem(items[0]);
        return;
      }
      response = { text: '', promptTokens: 0, completionTokens: 0 };
    }

    const parts = parseBatchTranslations(response.text, items.length);
    if (parts) {
      items.forEach((item, index) => applyResult(item, parts[index]));
      return;
    }
    if (items.length === 1) {
      // 单项批次常被兼容模型直接返回纯文本；复用已有响应，避免重复请求。
      applyResult(items[0], response.text);
      return;
    }
    if (recovery || recoveryRequests + 2 > MAX_BATCH_RECOVERY_REQUESTS) {
      throw new Error('模型没有返回完整的批量译文，请更换兼容模型或减小批次');
    }
    recoveryRequests += 2;
    const middle = Math.ceil(items.length / 2);
    await Promise.all([
      translateGroup(items.slice(0, middle), true),
      translateGroup(items.slice(middle), true),
    ]);
  };

  await translateGroup(toTranslate);
  return { translations: result, stats };
}

export async function translateBatch(
  cfg: AppConfig,
  texts: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  return (await translateBatchDetailed(cfg, texts, signal)).translations;
}

// ===== 传统翻译引擎（DeepL / Google / Microsoft） =====
async function translateMT(
  providerId: string,
  text: string,
  cfg: AppConfig,
  signal?: AbortSignal,
): Promise<string> {
  const source = langCode(cfg.sourceLang);
  const target = langCode(cfg.targetLang);
  const apiKey = cleanSecret(getProviderApiKey(cfg));
  if (providerId === 'google') {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${source}&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetchWithTimeout(url, { signal }, 20000);
    if (!res.ok) throw new Error(`Google 翻译失败 (${res.status})`);
    const data = await res.json();
    return (data?.[0] ?? []).map((seg: any) => seg?.[0] ?? '').join('');
  }
  if (providerId === 'deepl') {
    const url = `${cfg.baseUrl || 'https://api-free.deepl.com'}/v2/translate`;
    const body: Record<string, any> = { text: [text], target_lang: target.toUpperCase() };
    if (source !== 'auto') body.source_lang = source.toUpperCase();
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `DeepL-Auth-Key ${apiKey}` },
        body: JSON.stringify(body),
        signal,
      },
      20000,
    );
    if (!res.ok) throw new Error(`DeepL 翻译失败 (${res.status})：请检查 API Key`);
    const data = await res.json();
    return data?.translations?.[0]?.text ?? '';
  }
  if (providerId === 'microsoft') {
    const url = `${cfg.baseUrl || 'https://api.cognitive.microsofttranslator.com'}/translate?api-version=3.0&to=${target}${source !== 'auto' ? `&from=${source}` : ''}`;
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Ocp-Apim-Subscription-Key': apiKey,
        },
        body: JSON.stringify([{ Text: text }]),
        signal,
      },
      20000,
    );
    if (!res.ok) throw new Error(`Microsoft 翻译失败 (${res.status})：请检查 Key`);
    const data = await res.json();
    return data?.[0]?.translations?.[0]?.text ?? '';
  }
  throw new Error('不支持的传统翻译引擎');
}

interface MtBatchResult {
  translations: string[];
  requests: number;
}

async function translateMTBatch(
  providerId: string,
  texts: string[],
  cfg: AppConfig,
  signal?: AbortSignal,
): Promise<MtBatchResult> {
  if (texts.length === 0) return { translations: [], requests: 0 };
  const source = langCode(cfg.sourceLang);
  const target = langCode(cfg.targetLang);
  const apiKey = cleanSecret(getProviderApiKey(cfg));

  if (providerId === 'deepl') {
    const url = `${cfg.baseUrl || 'https://api-free.deepl.com'}/v2/translate`;
    const body: Record<string, unknown> = { text: texts, target_lang: target.toUpperCase() };
    if (source !== 'auto') body.source_lang = source.toUpperCase();
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `DeepL-Auth-Key ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    }, 20_000);
    if (!res.ok) throw new Error(`DeepL 翻译失败 (${res.status})：请检查 API Key`);
    const data = await res.json();
    const translations = Array.isArray(data?.translations)
      ? data.translations.map((item: any) => String(item?.text || ''))
      : [];
    if (translations.length !== texts.length) throw new Error('DeepL 返回的译文数量不完整');
    return { translations, requests: 1 };
  }

  if (providerId === 'microsoft') {
    const url = `${cfg.baseUrl || 'https://api.cognitive.microsofttranslator.com'}/translate?api-version=3.0&to=${target}${source !== 'auto' ? `&from=${source}` : ''}`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': apiKey,
      },
      body: JSON.stringify(texts.map((Text) => ({ Text }))),
      signal,
    }, 20_000);
    if (!res.ok) throw new Error(`Microsoft 翻译失败 (${res.status})：请检查 Key`);
    const data = await res.json();
    const translations = Array.isArray(data)
      ? data.map((item: any) => String(item?.translations?.[0]?.text || ''))
      : [];
    if (translations.length !== texts.length) throw new Error('Microsoft 返回的译文数量不完整');
    return { translations, requests: 1 };
  }

  // Google 的免费端点不保证多文本协议，使用有限并发避免逐条串行。
  const translations = new Array<string>(texts.length);
  let next = 0;
  const worker = async () => {
    while (next < texts.length) {
      const index = next++;
      translations[index] = await translateMT(providerId, texts[index], cfg, signal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, texts.length) }, () => worker()));
  return { translations, requests: texts.length };
}

// ===== LLM（OpenAI 兼容）文本翻译 =====
// glossaryBlock：本批文本相关的「术语对照表」，附加到 system 末尾（稳定前缀在前，利于供应商 Prompt Caching）。
async function callChat(
  cfg: AppConfig,
  text: string,
  extraInstruction?: string,
  glossaryBlock?: string,
  signal?: AbortSignal,
): Promise<ChatResult> {
  const base = (cfg.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置 API Base URL');
  const apiKey = cleanSecret(getProviderApiKey(cfg));
  const url = `${base}/chat/completions`;
  // 自定义提示词优先；否则用面向"自然流畅"的默认提示词（含风格 tone）
  const baseSystem =
    cfg.systemPrompt?.trim() || defaultSystem(cfg.targetLang, cfg.sourceLang, cfg.tone);
  const structuredHint = extraInstruction
    ? '\n\n对于结构化批量请求，必须严格遵循用户要求的 JSON 输出格式。'
    : '';
  const system = baseSystem + (glossaryBlock || '') + structuredHint;
  const userContent = extraInstruction ? `${extraInstruction}\n\n${text}` : text;
  const body = JSON.stringify({
    model: cfg.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ],
    temperature: 0.3,
  });

  // 统一的超时 + 重试 + 错误体处理（见 utils/requester.ts）
  const data = await postJson(
    url,
    {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body,
    { timeout: 20000, retries: 1, signal },
  );
  const content: string = data?.choices?.[0]?.message?.content ?? '';
  const promptTokens = Number(data?.usage?.prompt_tokens) || 0;
  const completionTokens = Number(data?.usage?.completion_tokens) || 0;
  const finishReason = String(data?.choices?.[0]?.finish_reason || '').toLowerCase();
  if (finishReason === 'length' || finishReason === 'max_tokens') {
    throw new TruncatedOutputError(promptTokens, completionTokens);
  }
  const translated = content.trim();
  if (!translated) throw new Error('翻译服务返回了空结果');
  return { text: translated, promptTokens, completionTokens };
}
