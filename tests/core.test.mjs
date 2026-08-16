import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONFIG,
  getProviderApiKey,
  normalizeConfig,
  withProviderApiKey,
} from '../utils/config.ts';
import { matchExact, parseCustomGlossary, relevantTerms } from '../utils/glossary.ts';
import {
  MAX_BATCH_ITEMS,
  MAX_TEXT_CHARS,
  readBatch,
  readJobId,
  readSingle,
} from '../utils/messages.ts';
import { fetchWithTimeout, postJson, RequestTimeoutError } from '../utils/requester.ts';
import { parseImageSegments, parseImageSegmentsResult } from '../utils/vision-parser.ts';
import {
  batchInstruction,
  createBatchItems,
  parseBatchTranslations,
} from '../utils/batch-protocol.ts';
import { localSkipReason } from '../utils/language-detection.ts';
import {
  accumulateUsage,
  createStats,
  estimateTokens,
  EMPTY_USAGE_TOTALS,
} from '../utils/usage.ts';
import { planTextChunks, splitLongText, takeFirstTextChunk } from '../utils/chunking.ts';
import { isRetryableTranslationError, NoticeCycleGate } from '../utils/notice-policy.ts';
import { SessionTranslationCache } from '../utils/session-translation-cache.ts';
import { randomId } from '../utils/id.ts';
import {
  isSiteDisabled,
  normalizeDisabledSites,
  siteKeyOf,
  withSiteDisabled,
} from '../utils/site-policy.ts';
import { TranslationJobRegistry } from '../utils/translation-jobs.ts';

test('migrates a legacy API key without exposing it to another provider', () => {
  const migrated = normalizeConfig({
    provider: 'openai',
    apiKey: 'openai-secret',
  });

  assert.equal(getProviderApiKey(migrated), 'openai-secret');
  assert.equal(getProviderApiKey({ ...migrated, provider: 'deepseek' }), '');

  const updated = withProviderApiKey({ ...migrated, provider: 'deepseek' }, 'deepseek-secret');
  assert.equal(getProviderApiKey(updated), 'deepseek-secret');
  assert.equal(getProviderApiKey(updated, 'openai'), 'openai-secret');
  assert.deepEqual(DEFAULT_CONFIG.apiKeys, {});
});

test('keeps an existing provider key when legacy data is also present', () => {
  const migrated = normalizeConfig({
    provider: 'openai',
    apiKey: 'legacy-secret',
    apiKeys: { openai: 'current-secret' },
  });
  assert.equal(getProviderApiKey(migrated), 'current-secret');
});

test('normalizes and updates per-site translation pauses', () => {
  assert.equal(siteKeyOf('https://Example.com/article'), 'example.com');
  assert.equal(siteKeyOf('http://example.com/other'), 'example.com');
  assert.equal(siteKeyOf('chrome://extensions'), null);
  assert.equal(siteKeyOf('file:///tmp/page.html'), null);

  const stored = normalizeDisabledSites([
    'Example.com',
    'https://example.com/old-path',
    'localhost:4173',
    'invalid site',
  ]);
  assert.deepEqual(stored, ['example.com', 'localhost:4173']);
  assert.equal(isSiteDisabled(stored, 'http://example.com/page'), true);
  assert.equal(isSiteDisabled(stored, 'https://open.example.com/page'), false);

  const enabled = withSiteDisabled(stored, 'https://example.com/page', false);
  assert.deepEqual(enabled, ['localhost:4173']);
  assert.deepEqual(withSiteDisabled(enabled, 'http://docs.example.com', true), [
    'localhost:4173',
    'docs.example.com',
  ]);
  assert.deepEqual(stored, ['example.com', 'localhost:4173']);

  const full = Array.from({ length: 500 }, (_, index) => `site-${index}.example`);
  const capped = withSiteDisabled(full, 'https://latest.example', true);
  assert.equal(capped.length, 500);
  assert.equal(capped.includes('site-0.example'), false);
  assert.equal(capped.at(-1), 'latest.example');
});

test('cancels active translation jobs and rejects requests that arrive late', async () => {
  const jobs = new TranslationJobRegistry(2);
  let release;
  const active = jobs.run(
    'page-job',
    (signal) =>
      new Promise((resolve, reject) => {
        release = resolve;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );

  jobs.cancel('page-job');
  await assert.rejects(active, (error) => error?.name === 'AbortError');
  await assert.rejects(
    jobs.run('page-job', async () => 'should not run'),
    (error) => error?.name === 'AbortError',
  );

  release?.();
  assert.equal(await jobs.run('another-job', async () => 'ok'), 'ok');
});

test('migrates retired display settings and keeps custom vision opt-in', () => {
  const migrated = normalizeConfig({ dualMode: false, customVision: true });
  assert.equal('dualMode' in migrated, false);
  assert.equal(migrated.customVision, true);
});

test('migrates the retired Zhipu endpoint without changing custom endpoints', () => {
  const migrated = normalizeConfig({
    provider: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/ai/v1/',
  });
  assert.equal(migrated.baseUrl, 'https://open.bigmodel.cn/api/paas/v4');

  const custom = normalizeConfig({ provider: 'custom', baseUrl: 'https://example.com/v1/' });
  assert.equal(custom.baseUrl, 'https://example.com/v1/');
});

test('validates translation message boundaries', () => {
  assert.deepEqual(readBatch({ payload: { texts: ['hello', 'world'] } }), ['hello', 'world']);
  assert.equal(readSingle({ payload: { text: 'hello' } }), 'hello');
  assert.equal(
    readJobId({ payload: { jobId: '123e4567-e89b-12d3-a456-426614174000' } }),
    '123e4567-e89b-12d3-a456-426614174000',
  );

  assert.throws(() => readBatch({ payload: { texts: [] } }), /不能为空/);
  assert.throws(
    () => readBatch({ payload: { texts: Array(MAX_BATCH_ITEMS + 1).fill('x') } }),
    /单批最多/,
  );
  assert.throws(
    () => readSingle({ payload: { text: 'x'.repeat(MAX_TEXT_CHARS + 1) } }),
    /不能超过/,
  );
  assert.throws(() => readJobId({ payload: { jobId: '../invalid' } }), /ID 无效/);
});

test('only skips target-language text when local detection is confident', () => {
  assert.equal(localSkipReason('这是一个中文页面', '中文'), 'targetLanguage');
  assert.equal(localSkipReason('これは日本語です', '中文'), null);
  assert.equal(localSkipReason('設定', '中文'), null);
  assert.equal(localSkipReason('Hello world', 'English'), null);
  assert.equal(localSkipReason('Hello world', 'English', 'English'), 'targetLanguage');
  assert.equal(localSkipReason('123 / 456', '中文'), 'nonLinguistic');
});

test('maps structured batch responses by stable IDs', () => {
  assert.deepEqual(createBatchItems(['one', 'two']), [
    { id: 't0', text: 'one' },
    { id: 't1', text: 'two' },
  ]);
  const response =
    '```json\n{"items":[{"id":"t1","translation":"二"},{"id":"t0","translation":"一"}]}\n```';
  assert.deepEqual(parseBatchTranslations(response, 2), ['一', '二']);
  assert.equal(parseBatchTranslations('{"items":[{"id":"t0","translation":"一"}]}', 2), null);
  assert.equal(
    parseBatchTranslations(
      '{"items":[{"id":"t0","translation":"一"},{"id":"t0","translation":"二"}]}',
      2,
    ),
    null,
  );
  assert.match(batchInstruction('中文'), /相同 id|id 原样出现一次/);
  assert.deepEqual(parseBatchTranslations('["一","二"]', 2), ['一', '二']);
  assert.deepEqual(parseBatchTranslations('{"translations":["一","二"]}', 2), ['一', '二']);
  // 顶层裸对象数组：部分模型不套 {items:[…]} 包裹，也应能正确映射（#2 修复）
  const bare = '[{"id":"t1","translation":"二"},{"id":"t0","translation":"一"}]';
  assert.deepEqual(parseBatchTranslations(bare, 2), ['一', '二']);
  assert.equal(parseBatchTranslations('[{"id":"t0","translation":"一"}]', 2), null);
  assert.equal(
    parseBatchTranslations('[{"id":"t0","translation":""},{"id":"t1","translation":"二"}]', 2),
    null,
  );
});

test('plans translation batches by both item and character limits', () => {
  const items = ['a'.repeat(4), 'b'.repeat(4), 'c'.repeat(7), 'd'];
  assert.deepEqual(
    planTextChunks(items, (text) => text, {
      maxItems: 3,
      maxCharacters: 10,
    }),
    [
      [items[0], items[1]],
      [items[2], items[3]],
    ],
  );
  assert.deepEqual(
    planTextChunks(['x'.repeat(20)], (text) => text, {
      maxItems: 2,
      maxCharacters: 5,
    }),
    [['x'.repeat(20)]],
  );

  const visibleQueue = ['a'.repeat(6), 'b'.repeat(6), 'c'];
  assert.deepEqual(
    takeFirstTextChunk(visibleQueue, (text) => text, {
      maxItems: 3,
      maxCharacters: 10,
    }),
    ['a'.repeat(6)],
  );
  assert.deepEqual(visibleQueue, ['b'.repeat(6), 'c']);
});

test('splits oversized text at readable boundaries without losing content', () => {
  const source = '第一句话很长。第二句话也很长。第三句话结束。';
  const parts = splitLongText(source, 10);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), source);
  assert.ok(parts.every((part) => part.length <= 10));
});

test('accumulates usage and estimates avoided tokens', () => {
  const stats = createStats(3);
  stats.cacheHits = 1;
  stats.estimatedTokensSaved = estimateTokens('Hello 世界');
  stats.promptTokens = 10;
  stats.completionTokens = 4;
  const total = accumulateUsage(EMPTY_USAGE_TOTALS, stats);
  assert.equal(total.translations, 1);
  assert.equal(total.inputSegments, 3);
  assert.equal(total.cacheHits, 1);
  assert.equal(total.promptTokens + total.completionTokens, 14);
  assert.ok(total.estimatedTokensSaved >= 4);
});

test('parses custom glossary entries and respects exact matching', () => {
  const custom = parseCustomGlossary('repository=代码仓库\n# comment\nissue -> 工单');
  assert.equal(matchExact('Repository!', '中文', custom), '代码仓库');
  const terms = relevantTerms(['Open repository settings'], '中文', custom);
  // 按长度升序注入（省 Token），内容仍完整、默认不超过 12 条
  assert.ok(terms.includes('Repository → 代码仓库'));
  assert.ok(terms.includes('Settings → 设置'));
  assert.ok(terms.length <= 12);
  assert.equal(terms[0], 'Open → 打开'); // 短术语优先（open 4 字符 < settings 8 字符）
});

test('sanitizes malformed image-model output and clamps overlays', () => {
  const many = Array.from({ length: 205 }, (_, index) => ({
    x: index === 0 ? 0.9 : 0,
    y: index === 0 ? -1 : 0,
    w: 0.5,
    h: 2,
    text: `source-${index}`,
    translation: `target-${index}`,
  }));
  many.splice(1, 0, null);
  const parsed = parseImageSegments(`\`\`\`json\n${JSON.stringify(many)}\n\`\`\``);

  assert.equal(parsed.length, 199);
  assert.equal(parsed[0].x, 0.9);
  assert.equal(parsed[0].y, 0);
  assert.ok(Math.abs(parsed[0].w - 0.1) < Number.EPSILON);
  assert.equal(parsed[0].h, 1);
  assert.equal(parsed[0].text, 'source-0');
  assert.equal(parsed[0].translation, 'target-0');
  assert.deepEqual(parseImageSegments('not json'), []);
  assert.equal(parseImageSegmentsResult('not json').valid, false);
  assert.deepEqual(parseImageSegmentsResult('[]'), { segments: [], valid: true });
});

test('bounds timeout retries and reports a typed timeout error', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (_url, init) => {
    attempts++;
    return await new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  };

  try {
    await assert.rejects(
      postJson('https://example.test', {}, '{}', { timeout: 5, retries: 1 }),
      RequestTimeoutError,
    );
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('retries 429 responses and honors a zero Retry-After delay', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    if (attempts === 1) {
      return new Response('busy', { status: 429, headers: { 'Retry-After': '0' } });
    }
    return Response.json({ ok: true });
  };

  try {
    assert.deepEqual(await postJson('https://example.test', {}, '{}', { retries: 1 }), {
      ok: true,
    });
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('forwards external cancellation and does not retry a cancelled request', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (_url, init) => {
    attempts++;
    return await new Promise((_resolve, reject) => {
      if (init.signal.aborted) {
        reject(init.signal.reason);
        return;
      }
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  };

  try {
    const controller = new AbortController();
    const request = postJson('https://example.test', {}, '{}', {
      retries: 2,
      signal: controller.signal,
    });
    controller.abort(new Error('cancelled'));
    await assert.rejects(request, /cancelled/);
    assert.equal(attempts, 1);

    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort(new Error('already cancelled'));
    await assert.rejects(
      fetchWithTimeout('https://example.test', { signal: alreadyCancelled.signal }),
      /already cancelled/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('shows one notice per user operation and only retries transient failures', () => {
  const gate = new NoticeCycleGate(2);
  assert.equal(gate.shouldShow('page-a'), true);
  assert.equal(gate.shouldShow('page-a'), false);
  assert.equal(gate.shouldShow('page-b'), true);
  assert.equal(gate.shouldShow('page-c'), true);
  assert.equal(gate.shouldShow('page-a'), true);

  assert.equal(isRetryableTranslationError(new Error('请先在设置页填写 API Key')), false);
  assert.equal(isRetryableTranslationError(new Error('请求失败 (401)')), false);
  assert.equal(isRetryableTranslationError(new Error('请求超时（20 秒）')), true);
  assert.equal(isRetryableTranslationError(new Error('请求失败 (429)')), true);
  assert.equal(isRetryableTranslationError(new Error('Failed to fetch')), true);
});

test('reuses translations within a page session and evicts the least recently used entry', () => {
  const cache = new SessionTranslationCache(2);
  cache.remember('Public', '公开');
  cache.remember('Private', '私有');
  assert.equal(cache.get('Public'), '公开');

  cache.remember('Create repository', '创建仓库');
  assert.equal(cache.get('Private'), undefined);
  assert.equal(cache.get('Public'), '公开');
  assert.equal(cache.get('Create repository'), '创建仓库');

  cache.clear();
  assert.equal(cache.size, 0);
});

test('generates RFC 4122 version 4 IDs without randomUUID', () => {
  const first = randomId();
  const second = randomId();
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, second);
});
