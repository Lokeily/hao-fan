// 月度预算用量回归：跨月自动归零、同月累加、非法输入钳制。
import test from 'node:test';
import assert from 'node:assert/strict';

const { addMonthUsage, currentYearMonth, EMPTY_USAGE_TOTALS, accumulateUsage } = await import(
  '../utils/usage.ts'
);

test('currentYearMonth 输出 YYYY-MM 格式', () => {
  const ym = currentYearMonth(new Date('2026-09-27T12:00:00').getTime());
  assert.match(ym, /^\d{4}-\d{2}$/);
  assert.equal(ym, '2026-09');
});

test('同月累加：后续调用在当月累计', () => {
  const base = addMonthUsage(null, 100, new Date('2026-09-01T00:00:00').getTime());
  const next = addMonthUsage(base, 250, new Date('2026-09-15T00:00:00').getTime());
  assert.deepEqual(next, { yearMonth: '2026-09', usedTokens: 350 });
});

test('跨月自动归零：新月份从头累计', () => {
  const sep = addMonthUsage(null, 5000, new Date('2026-09-30T23:00:00').getTime());
  const oct = addMonthUsage(sep, 200, new Date('2026-10-01T00:00:00').getTime());
  assert.deepEqual(oct, { yearMonth: '2026-10', usedTokens: 200 });
});

test('跨年同样归零', () => {
  const dec = addMonthUsage(null, 100, new Date('2026-12-31T23:00:00').getTime());
  const jan = addMonthUsage(dec, 50, new Date('2027-01-01T00:00:00').getTime());
  assert.deepEqual(jan, { yearMonth: '2027-01', usedTokens: 50 });
});

test('负数 token 钳制为 0，不污染统计', () => {
  const base = addMonthUsage(null, -999, new Date('2026-09-01T00:00:00').getTime());
  assert.deepEqual(base, { yearMonth: '2026-09', usedTokens: 0 });
});

test('accumulateUsage 累计 prompt/completion 并可被 EMPTY 基准复位', () => {
  const base = accumulateUsage(EMPTY_USAGE_TOTALS, {
    inputSegments: 1,
    localSkipped: 0,
    cacheHits: 0,
    glossaryHits: 0,
    duplicateHits: 0,
    sentSegments: 1,
    sentCharacters: 10,
    estimatedTokensSaved: 8,
    promptTokens: 100,
    completionTokens: 50,
    requests: 1,
    qualityIssues: 0,
  });
  assert.equal(base.promptTokens, 100);
  assert.equal(base.completionTokens, 50);
  assert.equal(base.translations, 1);
  assert.equal(base.estimatedTokensSaved, 8);
});
