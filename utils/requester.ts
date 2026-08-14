// 统一的网络请求层：所有对外 API 调用都走这里，保证超时 / 重试 / 错误体处理行为一致。
// 文字翻译与图片翻译共用，避免两侧逻辑分叉导致“一个会重试一个不会”这类失误。

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class RequestTimeoutError extends Error {
  readonly timeout: number;

  constructor(timeout: number) {
    super(`请求超时（${Math.ceil(timeout / 1000)} 秒）`);
    this.name = 'RequestTimeoutError';
    this.timeout = timeout;
  }
}

class HttpRequestError extends Error {
  readonly status: number;
  readonly retryAfter: number | null;

  constructor(status: number, detail: string, retryAfter: number | null) {
    super(`请求失败 (${status})${detail ? `：${detail.slice(0, 300)}` : ''}`);
    this.name = 'HttpRequestError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(10_000, seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(10_000, date - Date.now())) : null;
}

// ===== 请求头 Latin-1 防护（核心：消除用户报的 ISO-8859-1 报错） =====
// Service Worker 的 fetch 严格要求 header 值必须是 ISO-8859-1（Latin-1）；
// 任何 > U+00FF 的字符（中文、全角符号、emoji 等）都会导致：
//   "String contains non ISO-8859-1 code point"
// 而 API Key 放进 Authorization 头时，复制粘贴常会混入全角空格/不可见字符。

// 清理密钥：去掉首尾所有空白（含全角空格 U+3000、不间断空格 U+00A0、零宽字符），
// 若仍含非 ASCII 字符则抛出清晰中文错误，提示用户重新复制纯 ASCII 的 Key。
// 用码点判断而非正则字面量，避免源码里混入非 ASCII 字符。
export function cleanSecret(key: string): string {
  const s = key || '';
  const isTrim = (c: string): boolean => {
    const code = c.charCodeAt(0);
    return (
      code <= 0x20 || // ASCII 控制符 + 空格
      code === 0x00a0 || // 不间断空格 NBSP
      code === 0x3000 || // 全角空格
      (code >= 0x2000 && code <= 0x200a) || // 各类 Unicode 空格
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x202f ||
      code === 0x205f ||
      (code >= 0x200b && code <= 0x200d) || // 零宽空格 / 连字符
      code === 0xfeff // BOM / 零宽无断空格
    );
  };
  let start = 0;
  let end = s.length;
  while (start < end && isTrim(s[start])) start++;
  while (end > start && isTrim(s[end - 1])) end--;
  const trimmed = s.slice(start, end);
  if (/[^\x21-\x7e]/.test(trimmed)) {
    throw new Error(
      'API Key 含有空白、控制符或非 ASCII 字符。请重新从服务商后台复制纯英文/数字的 Key，并确保中间和前后没有多余空格。',
    );
  }
  return trimmed;
}

// 兜底：保证任意 header 值都是 Latin-1，避免 fetch 在 Service Worker 中崩溃。
function toLatin1(v: string): string {
  // eslint-disable-next-line no-control-regex -- 故意匹配并剔除控制字符/非 Latin-1 字符
  return String(v).replace(/[^\u0000-\u00FF]/g, '');
}

// 带超时的 fetch（AbortController）。超时与用户主动取消使用不同错误类型。
export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  ms = 30000,
): Promise<Response> {
  const ctrl = new AbortController();
  const externalSignal = init?.signal;
  const abortFromExternal = () => ctrl.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  const timeoutError = new RequestTimeoutError(ms);
  const timer = setTimeout(() => ctrl.abort(timeoutError), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (error) {
    if (externalSignal?.aborted) throw externalSignal.reason ?? error;
    if (ctrl.signal.aborted) throw ctrl.signal.reason ?? timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

export interface PostJsonOpts {
  timeout?: number; // 单次超时（毫秒）
  retries?: number; // 5xx / 网络错误的重试次数
  signal?: AbortSignal;
}

// 统一的 POST-JSON：20s 超时 + 最多一次重试；仅重试超时、网络错误、429 与 5xx。
// 返回已解析的 JSON；若 HTTP 200 但 body 带 error 字段，同样抛错（P2-6）。
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: string,
  opts: PostJsonOpts = {},
): Promise<any> {
  const timeout = opts.timeout ?? 20000;
  const retries = opts.retries ?? 1;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    opts.signal?.throwIfAborted();
    try {
      // 兜底清洗：任何 header 值里的非 Latin-1 字符都会被剔除，确保 Service Worker 的 fetch 不抛错
      const safeHeaders: Record<string, string> = {};
      for (const k of Object.keys(headers)) {
        safeHeaders[k] = toLatin1(headers[k]);
      }
      const res = await fetchWithTimeout(
        url,
        { method: 'POST', headers: safeHeaders, body, signal: opts.signal },
        timeout,
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new HttpRequestError(
          res.status,
          detail,
          retryAfterMs(res.headers.get('retry-after')),
        );
      }
      const data = await res.json();
      if (data?.error) {
        throw new Error(`请求失败：${data.error?.message || JSON.stringify(data.error)}`);
      }
      return data;
    } catch (e) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? e;
      const retryable =
        e instanceof RequestTimeoutError ||
        e instanceof TypeError ||
        (e instanceof HttpRequestError &&
          (e.status === 408 || e.status === 425 || e.status === 429 || e.status >= 500));
      if (!retryable) throw e;
      lastErr = e;
      if (attempt < retries) {
        const serverDelay = e instanceof HttpRequestError ? e.retryAfter : null;
        const backoff = serverDelay ?? 350 * 2 ** attempt + Math.floor(Math.random() * 150);
        await sleep(backoff, opts.signal);
      }
    }
  }
  throw lastErr ?? new Error('请求失败');
}

export interface StreamMeta {
  promptTokens?: number;
  completionTokens?: number;
  finishReason?: string;
}

// ===== SSE 流式聊天：边收边 yield 文本增量，首字延迟从「整块返回」降到「首个 token 到达」。 =====
// 与 postJson 共享 header 的 Latin-1 兜底清洗与超时/取消逻辑。
// 兼容两种响应形态：
//   - 标准 SSE：每行 `data: {json}`，以 `data: [DONE]` 结束（OpenAI 兼容）。
//   - 非流式兜底：个别端点忽略 stream 标志直接返回 `{choices:[{message:{content}}]}`，
//     解析到 message.content 时一次性 yield。
export async function* streamChat(
  url: string,
  headers: Record<string, string>,
  body: string,
  opts: PostJsonOpts & { onMeta?: (meta: StreamMeta) => void } = {},
): AsyncGenerator<string, void, unknown> {
  const timeout = opts.timeout ?? 20000;
  const safeHeaders: Record<string, string> = {};
  for (const k of Object.keys(headers)) safeHeaders[k] = toLatin1(headers[k]);

  const res = await fetchWithTimeout(
    url,
    { method: 'POST', headers: safeHeaders, body, signal: opts.signal },
    timeout,
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new HttpRequestError(res.status, detail, retryAfterMs(res.headers.get('retry-after')));
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    // 极端环境下 body 不可读：退化为一次性 JSON。
    const data = await res.json();
    yield contentFromChunk(data) ?? '';
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        const delta = parseSseLine(line, opts.onMeta);
        if (delta !== null) yield delta;
      }
    }
    const tail = buffer.replace(/\r$/, '');
    if (tail.trim()) {
      const delta = parseSseLine(tail, opts.onMeta);
      if (delta !== null) yield delta;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* 已结束 */
    }
  }
}

function parseSseLine(line: string, onMeta?: (meta: StreamMeta) => void): string | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  if (payload === '[DONE]') return null;
  let json: any;
  try {
    json = JSON.parse(payload);
  } catch {
    return null;
  }
  // 增量：delta.content
  const delta = json?.choices?.[0]?.delta?.content;
  if (typeof delta === 'string' && delta.length > 0) return delta;
  // 兜底：非流式 message.content 一次性给出
  const messageContent = json?.choices?.[0]?.message?.content;
  if (typeof messageContent === 'string' && messageContent.length > 0) return messageContent;
  // 用量与结束原因
  const finish = json?.choices?.[0]?.finish_reason;
  if (typeof finish === 'string' && onMeta) {
    onMeta({ finishReason: finish });
  }
  const usage = json?.usage;
  if (usage && onMeta) {
    onMeta({
      promptTokens: Number(usage.prompt_tokens) || 0,
      completionTokens: Number(usage.completion_tokens) || 0,
    });
  }
  return null;
}

function contentFromChunk(data: any): string | null {
  return data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.delta?.content ?? null;
}
