// 性能基线：在重页面（2000 段长文）上采集翻译管线的关键指标。
// 产出：首译耗时、扫描期间主线程长任务数/最长任务、总译文数、完整翻译耗时。
// 本测试不做严格数值断言（CI 波动会导致假红），只做健全性检查并输出 JSON，
// 供本地对比与后续优化参考：npm run perf 或 npx playwright test perf
import { expect, test } from '@playwright/test';

test('perf baseline: long article translation pipeline', async ({ page }) => {
  await page.goto('/tests/browser/perf-long-article.html');
  await expect(page.locator('#ot-toolbar')).toBeVisible();

  // 记录主线程长任务（>50ms 的任务）与翻译进度
  await page.evaluate(() => {
    (window as any).__perf = {
      longTasks: [],
      firstTranslationAt: null,
      translationCount: 0,
    };
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          (window as any).__perf.longTasks.push({
            duration: Math.round(entry.duration),
            start: Math.round(entry.startTime),
          });
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch {
      /* longtask 条目不可用时跳过 */
    }
    const t0 = performance.now();
    new MutationObserver(() => {
      const count = document.querySelectorAll('.ot-translation').length;
      const perf = (window as any).__perf;
      perf.translationCount = count;
      if (count > 0 && perf.firstTranslationAt === null) {
        perf.firstTranslationAt = Math.round(performance.now() - t0);
      }
    }).observe(document.body, { childList: true, subtree: true });
    (window as any).__perf.t0 = Math.round(t0);
  });

  // 点击翻译并等待完成（aria-busy 回到 false）
  const clickAt = Date.now();
  await page.locator('#ot-toolbar').click();
  await expect(page.locator('#ot-toolbar')).toHaveAttribute('aria-busy', 'false', {
    timeout: 180_000,
  });
  const doneAt = Date.now();

  // 滚动触发懒翻译：分步滚到底再回顶，让 IntersectionObserver 消化全页
  await page.evaluate(async () => {
    const step = Math.floor(window.innerHeight * 0.7);
    const total = document.documentElement.scrollHeight;
    for (let y = 0; y < total; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    window.scrollTo(0, 0);
  });
  // 等待懒翻译队列稳定（滚动触发 + 队列清空）
  await page.waitForTimeout(6000);

  const perf = await page.evaluate(() => (window as any).__perf);
  const totalTranslations = await page.locator('.ot-translation').count();
  const longTasks = perf.longTasks.sort((a: any, b: any) => b.duration - a.duration);

  const report = {
    firstTranslationMs: perf.firstTranslationAt,
    totalPipelineMs: doneAt - clickAt,
    totalTranslations,
    longTaskCount: perf.longTasks.length,
    longestTaskMs: longTasks[0]?.duration ?? 0,
    longTasksOver200ms: longTasks.filter((t: any) => t.duration >= 200).length,
  };
  console.log('PERF_BASELINE ' + JSON.stringify(report));

  // 健全性断言（宽松，避免 CI 波动误报）：
  expect(report.totalTranslations).toBeGreaterThan(1000); // 重页面大部分段落已翻译
  expect(report.firstTranslationMs).not.toBeNull(); // 首译确实发生
  expect(report.totalPipelineMs).toBeLessThan(120_000); // 完整管线在 2 分钟内完成
});
