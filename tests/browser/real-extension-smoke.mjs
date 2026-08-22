// 真实 Chrome 加载未打包扩展的端到端冒烟（v3，纯净页面）：
//  ① 扩展真实启动：content script 注入、工具栏出现
//  ② 无 Key：自动翻译被引导卡拦下（不弹请求）、点「译」同样被拦
//  ③ 用扩展自己的快速设置面板切到 google（免 Key）→ 点「译」→ 真实网络翻译出译文
// 注意：需在真实桌面 Chrome 环境运行（沙箱/无头环境不支持 --load-extension）：
//   node tests/browser/real-extension-smoke.mjs
/* eslint-env node */
import { chromium } from '@playwright/test';

const extPath = '/Users/lokei/WorkBuddy/2026-08-14-07-18-22/hao-fan/.output/chrome-mv3';
const results = [];
const record = (name, ok, detail = '') => results.push({ name, ok, detail });

let context;
try {
  context = await chromium.launchPersistentContext('', {
    channel: 'chrome',
    headless: true,
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      '--no-first-run',
      '--disable-features=Translate',
    ],
  });

  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${String(err).slice(0, 200)}`));

  await page.goto('http://127.0.0.1:4173/tests/browser/smoke-page.html', {
    waitUntil: 'domcontentloaded',
  });
  const translateBtn = page.locator('#ot-translate-btn');
  let toolbarShown = false;
  try {
    await translateBtn.waitFor({ state: 'visible', timeout: 10_000 });
    toolbarShown = true;
  } catch {}
  record('内容脚本注入 + 工具栏出现', toolbarShown);

  // ② 无 Key：自动翻译应被引导卡拦下，且页面无任何译文节点
  let guideOnLoad = false;
  try {
    await page.locator('#ot-error-modal').waitFor({ state: 'visible', timeout: 8000 });
    guideOnLoad = true;
  } catch {}
  const noTranslationBefore = (await page.locator('.ot-translation').count()) === 0;
  record('无 Key 自动翻译被引导卡拦截（零译文）', guideOnLoad && noTranslationBefore);

  // 关闭引导卡
  await page
    .locator('#ot-error-modal')
    .getByRole('button', { name: '我知道了' })
    .click()
    .catch(() => {});

  // ③ 用真实设置面板切到 google（免 Key）
  await page.locator('#ot-settings-btn').click();
  const panel = page.locator('#ot-settings-panel');
  let panelShown = false;
  try {
    await panel.waitFor({ state: 'visible', timeout: 5000 });
    panelShown = true;
  } catch {}
  record('快速设置面板打开', panelShown);

  if (panelShown) {
    await panel.getByRole('combobox', { name: '翻译引擎' }).selectOption('google');
    await page.waitForTimeout(600); // 等配置落盘
    await page.locator('#ot-settings-panel').locator('.close').click().catch(() => {});
  }

  // 点「译」→ 真实网络翻译
  await translateBtn.click();
  let translated = false;
  let detail = '';
  try {
    await page.locator('.ot-translation .text').first().waitFor({ state: 'visible', timeout: 30_000 });
    const t = await page.locator('.ot-translation .text').first().textContent();
    translated = !!t && t.length > 0;
    detail = `示例译文：${(t || '').slice(0, 40)}`;
  } catch (e) {
    detail = `超时未出现译文: ${String(e).slice(0, 120)}`;
    const notice = await page.locator('#ot-error-modal').textContent().catch(() => '');
    if (notice) detail += ` | 错误弹窗: ${notice.slice(0, 120)}`;
  }
  record('google 免 Key 真实网络翻译', translated, detail);

  record('页面无 JS 报错', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));
} catch (error) {
  record('冒烟脚本异常', false, String(error).slice(0, 300));
} finally {
  await context?.close().catch(() => {});
}

let allOk = true;
for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  if (!r.ok) allOk = false;
}
console.log(allOk ? '\nSMOKE: ALL PASS' : '\nSMOKE: SOME FAILED');
process.exit(allOk ? 0 : 1);
