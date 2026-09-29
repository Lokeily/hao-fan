import { expect, test } from '@playwright/test';

test('selection translation works on an insecure page', async ({ page }) => {
  await page.goto('/tests/browser/selection-regression.html');
  await expect(page.locator('#ot-toolbar')).toBeVisible();

  await page.getByRole('button', { name: 'Create selection' }).click();
  const selectionUi = page.locator('#ot-selection-ui');
  const trigger = selectionUi.getByRole('button', { name: '翻译选中内容' });
  await expect(trigger).toBeVisible();
  await trigger.click();

  const dialog = selectionUi.getByRole('dialog', { name: '划词翻译结果' });
  await expect(dialog).toContainText('启用双重身份验证');
  await expect(page.locator('html')).toHaveAttribute('data-single-requests', '1');
});

test('batch mismatch falls back with bounded concurrency and translates revealed content', async ({
  page,
}) => {
  await page.goto('/tests/browser/selection-regression.html');
  const toolbar = page.locator('#ot-toolbar');
  await expect(toolbar).toBeVisible();
  await toolbar.click();
  await expect(toolbar).toHaveAttribute('aria-busy', 'false');

  const root = page.locator('html');
  await expect
    .poll(async () => Number(await root.getAttribute('data-single-requests')))
    .toBeGreaterThan(0);
  expect(Number(await root.getAttribute('data-max-active-singles'))).toBeLessThanOrEqual(2);

  const callsBeforeReveal = Number(await root.getAttribute('data-translation-calls'));
  await page.getByRole('button', { name: 'Toggle panel' }).click();
  await expect(page.locator('#controlled-panel .ot-translation')).toBeVisible();
  await expect
    .poll(async () => Number(await root.getAttribute('data-translation-calls')))
    .toBeGreaterThan(callsBeforeReveal);
});

test('page extraction excludes site chrome while keeping reading content', async ({ page }) => {
  await page.goto('/tests/browser/dom-regression.html');
  const toolbar = page.locator('#ot-toolbar');
  await expect(toolbar).toBeVisible();
  await toolbar.click();
  await expect(toolbar).toHaveAttribute('aria-busy', 'false');

  const requestedTexts = await page.locator('html').getAttribute('data-requested-texts');
  const requested = JSON.parse(requestedTexts || '[]') as string[];
  expect(requested.some((text) => text.includes('Open menu'))).toBe(false);
  expect(requested.some((text) => text.includes('Profile settings'))).toBe(false);
  expect(requested.some((text) => text.includes('Close menu'))).toBe(false);
  expect(requested.some((text) => text.includes('Authenticator apps'))).toBe(true);
  expect(requested.some((text) => text.includes('Alternative recovery options'))).toBe(true);
  expect(requested.some((text) => text.includes('Anyone on the internet'))).toBe(true);
  expect(requested.some((text) => text === 'All repositories')).toBe(true);

  await page.getByRole('button', { name: 'Add dynamic content' }).click();
  await expect(page.locator('#processed-parent .ot-translation')).toBeVisible();
  await expect
    .poll(async () => {
      const value = await page.locator('html').getAttribute('data-requested-texts');
      return JSON.parse(value || '[]').some((text: string) => text.includes('New content loaded'));
    })
    .toBe(true);
});

test('a cancelled task cannot clear the loading state of its replacement', async ({ page }) => {
  await page.goto('/tests/browser/dom-regression.html');
  await page.locator('html').evaluate((element) => {
    element.dataset.batchDelays = JSON.stringify([500, 1500]);
  });

  const toolbar = page.locator('#ot-toolbar');
  const root = page.locator('html');
  await toolbar.click();
  await expect.poll(async () => Number(await root.getAttribute('data-batch-requests'))).toBe(1);
  await expect(toolbar).toHaveAttribute('aria-busy', 'true');
  // 加载态：旋转圆圈指示器 + "取消翻译" 文案
  await expect(page.locator('#ot-translate-btn .ot-toolbar-spinner')).toBeVisible();
  await expect(page.locator('#ot-translate-btn')).toContainText('取消翻译');

  await toolbar.click();
  await toolbar.click();
  await expect.poll(async () => Number(await root.getAttribute('data-batch-requests'))).toBe(2);
  await expect.poll(async () => Number(await root.getAttribute('data-batch-completions'))).toBe(1);

  await expect(toolbar).toHaveAttribute('aria-busy', 'true');
  await expect(toolbar).toHaveAttribute('aria-label', '取消当前翻译');
  await expect(toolbar).toHaveAttribute('aria-busy', 'false');
  expect(Number(await root.getAttribute('data-batch-completions'))).toBeGreaterThanOrEqual(2);
});

test('a paused site stays quiet and resumes without a reload', async ({ page }) => {
  await page.goto('/tests/browser/selection-regression.html?disabled=1');
  const toolbar = page.locator('#ot-toolbar');
  await expect(toolbar).toHaveCount(0);

  await page.getByRole('button', { name: 'Create selection' }).click();
  await expect(page.locator('#ot-selection-ui')).toHaveCount(0);

  await page.evaluate(async () => {
    await (window as any).__setHaofanDisabledSites([]);
  });
  await expect(toolbar).toBeVisible();

  await page.getByRole('button', { name: 'Create selection' }).click();
  await expect(
    page.locator('#ot-selection-ui').getByRole('button', { name: '翻译选中内容' }),
  ).toBeVisible();
});

test('a newer site policy change wins over a stale initial read', async ({ page }) => {
  await page.goto('/tests/browser/selection-regression.html?policyRace=1');
  await expect(page.locator('#ot-toolbar')).toHaveCount(0);
});

test('a direct site policy message wins over a stale initial read', async ({ page }) => {
  await page.goto('/tests/browser/selection-regression.html?policyMessageRace=1');
  await expect(page.locator('#ot-toolbar')).toHaveCount(0);
});

test('closing a translating selection cancels its background job', async ({ page }) => {
  await page.goto('/tests/browser/selection-regression.html');
  await page.locator('html').evaluate((element) => {
    element.dataset.singleDelay = '500';
  });
  await page.getByRole('button', { name: 'Create selection' }).click();
  const selectionUi = page.locator('#ot-selection-ui');
  await selectionUi.getByRole('button', { name: '翻译选中内容' }).click();
  await expect
    .poll(async () => Number(await page.locator('html').getAttribute('data-single-requests')))
    .toBe(1);
  await selectionUi.getByRole('button', { name: '关闭划词翻译' }).click();
  await expect
    .poll(async () => Number(await page.locator('html').getAttribute('data-cancel-requests')))
    .toBe(1);
});

test('the popup can pause and resume translation for the active site', async ({ page }) => {
  await page.goto('/tests/browser/popup-regression.html');
  const toggle = page.getByRole('switch', { name: '在当前网站启用翻译' });
  const pageButton = page.getByRole('button', { name: '翻译网页' });

  await expect(toggle).toBeVisible();
  await expect(toggle).toBeChecked();
  await expect(page.locator('#ot-site-host')).toHaveText('docs.example.com');
  await expect(page.locator('#ot-site-state')).toHaveText('已启用');
  await expect(pageButton).toBeEnabled();

  await toggle.uncheck();
  await expect(page.locator('#ot-site-state')).toHaveText('已暂停');
  await expect(pageButton).toBeDisabled();
  await expect(page.locator('#ot-out')).toContainText('已暂停当前网站翻译');

  await toggle.check();
  await expect(page.locator('#ot-site-state')).toHaveText('已启用');
  await expect(pageButton).toBeEnabled();
  await expect(page.locator('#ot-out')).toContainText('已恢复当前网站翻译');
});

test('the popup resets a rejected image so the same file can be selected again', async ({
  page,
}) => {
  await page.goto('/tests/browser/popup-regression.html');
  const input = page.locator('#ot-file');
  const status = page.locator('#ot-img-status');

  await input.setInputFiles('public/icon-16.png');
  await expect(status).toContainText('当前引擎不支持图片');
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue('');

  await status.evaluate((element) => {
    element.textContent = '等待重试';
  });
  await input.setInputFiles('public/icon-16.png');
  await expect(status).toContainText('当前引擎不支持图片');
  await expect(input).toHaveValue('');
});

test('popup tabs support keyboard navigation and show a live character count', async ({ page }) => {
  await page.goto('/tests/browser/popup-regression.html');
  const translateTab = page.getByRole('tab', { name: '翻译' });
  await translateTab.focus();
  // 翻译 → 历史 → 设置 →（循环）翻译：三标签键盘导航
  await translateTab.press('ArrowRight');
  const historyTab = page.getByRole('tab', { name: '历史' });
  await expect(historyTab).toHaveAttribute('aria-selected', 'true');
  await historyTab.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '设置' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: '设置' }).press('ArrowLeft');
  await expect(historyTab).toHaveAttribute('aria-selected', 'true');

  // 历史标签页基础形态：搜索框与空态提示
  await page.locator('#ot-history-search').fill('');
  await expect(page.locator('#ot-history-list')).toBeVisible();

  // 环形导航：历史 →（ArrowLeft 回绕）→ 翻译
  await historyTab.press('ArrowLeft');
  await expect(translateTab).toHaveAttribute('aria-selected', 'true');

  await page.locator('#ot-input').fill('hello');
  await expect(page.locator('#ot-input-count')).toHaveText('5 / 20,000');
});

test('manual mode is the v0.2.0 default: page loads clean until user clicks', async ({ page }) => {
  // 预置「手动模式 + 已配 Key」：验证载入零自动翻译，点击段落才翻译
  await page.addInitScript(() => {
    localStorage.setItem(
      'mock-storage:config',
      JSON.stringify({
        provider: 'deepseek',
        apiKeys: { deepseek: 'test-key-for-browser-regression' },
        model: 'deepseek-chat',
        sourceLang: '自动检测',
        targetLang: '中文',
        cacheEnabled: true,
        streaming: true,
        qualityCheck: true,
        translateMode: 'manual',
      }),
    );
  });
  await page.goto('/tests/browser/dom-regression.html');
  const toolbar = page.locator('#ot-toolbar');
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toHaveAttribute('aria-label', /手动模式/);
  await page.waitForTimeout(1200);
  expect(await page.locator('.ot-translation').count()).toBe(0);

  // 用户点击段落 → 该段出现译文
  await page.getByRole('heading', { name: /Setup authenticator app/i }).click();
  await expect(page.locator('.ot-translation').first()).toBeVisible({ timeout: 20000 });
});

test('per-site auto-translate overrides global manual mode', async ({ page }) => {
  // 全局手动 + 站点级显式自动 → 该站加载后仍应自动整页翻译
  await page.addInitScript(() => {
    localStorage.setItem(
      'mock-storage:config',
      JSON.stringify({
        provider: 'deepseek',
        apiKeys: { deepseek: 'test-key-for-browser-regression' },
        model: 'deepseek-chat',
        sourceLang: '自动检测',
        targetLang: '中文',
        cacheEnabled: true,
        streaming: true,
        qualityCheck: true,
        translateMode: 'manual',
      }),
    );
    localStorage.setItem(
      'mock-storage:autoSites',
      JSON.stringify(['127.0.0.1:4173']),
    );
  });
  await page.goto('/tests/browser/dom-regression.html');
  await expect(page.locator('.ot-translation').first()).toBeVisible({ timeout: 20000 });
});

test('critical: setup guide never hijacks the full settings panel', async ({ page }) => {
  // 复现恶性 bug：手动模式 + 无 Key，打开完整设置面板准备输入 Key 时，
  // 点击面板内任意位置都会重新弹出「还差一步就能开始翻译」引导，完全无法输入。
  await page.addInitScript(() => {
    localStorage.setItem(
      'mock-storage:config',
      JSON.stringify({
        provider: 'deepseek',
        apiKeys: {},
        model: 'deepseek-chat',
        sourceLang: '自动检测',
        targetLang: '中文',
        cacheEnabled: true,
        streaming: true,
        qualityCheck: true,
        translateMode: 'manual',
      }),
    );
    localStorage.setItem('mock-storage:v2ManualDefaultApplied', 'true');
  });
  await page.goto('/tests/browser/dom-regression.html');

  // 打开快速面板 → 完整设置
  await page.locator('#ot-settings-btn').click();
  await page.locator('#ot-settings-panel').getByRole('button', { name: '打开完整设置' }).click();
  const full = page.locator('#ot-full-settings');
  await expect(full).toBeVisible();

  // 首次弹出的引导卡应已被「打开设置」关闭；点击标题栏不得再触发引导
  await full.locator('.head .title').click();
  await expect(page.locator('#ot-error-modal')).toHaveCount(0);

  // 核心：点击 API Key 输入框并输入——全程不得弹出引导、值必须保留
  const keyInput = full.locator('[data-f=apiKey]');
  await keyInput.click();
  await keyInput.pressSequentially('sk-test-123');
  await expect(keyInput).toHaveValue('sk-test-123');
  await expect(page.locator('#ot-error-modal')).toHaveCount(0);

  // 点击面板内其他区域同样安全
  await full.locator('h2', { hasText: '翻译引擎' }).click();
  await expect(page.locator('#ot-error-modal')).toHaveCount(0);
});

test('menu pages load the configured brand logo asset', async ({ page }) => {
  await page.goto('/tests/browser/popup-regression.html');
  const logo = page.locator('.ot-brand-mark img');
  await expect(logo).toHaveAttribute('src', '/public/icon-128.png');
  await expect
    .poll(async () => logo.evaluate((image) => (image as HTMLImageElement).naturalWidth))
    .toBe(128);
});

test('settings wait for stored configuration before becoming editable', async ({ page }) => {
  await page.goto('/tests/browser/options-regression.html?configDelay=1');
  const provider = page.getByRole('combobox', { name: '翻译引擎' });
  await expect(provider).toBeDisabled();
  await expect(provider).toBeEnabled();
  await expect(page.getByRole('heading', { name: '翻译设置' })).toBeVisible();
});

test('image result page renders counts and toggles overlays', async ({ page }) => {
  await page.goto('/tests/browser/image-regression.html?job=test&imageResult=1');
  await expect(page.getByRole('heading', { name: '图片翻译' })).toBeVisible();
  await expect(page.locator('#result-count')).toHaveText('1 处文本');
  await expect(page.locator('.ot-image-stage img')).toBeVisible();
  const overlay = page.locator('.ot-image-segment');
  await expect(overlay).toBeVisible();
  await page.getByRole('checkbox', { name: '显示图片上的译文' }).uncheck();
  await expect(overlay).toBeHidden();
});

test('image result page explains missing tasks instead of leaving a blank page', async ({
  page,
}) => {
  await page.goto('/tests/browser/image-regression.html');
  await expect(page.getByRole('heading', { name: '缺少图片翻译任务' })).toBeVisible();
});

test('two-column layout: each column keeps its own translations', async ({ page }) => {
  await page.goto('/tests/browser/two-column-regression.html');
  await expect(page.locator('#ot-toolbar')).toBeVisible();
  await page.locator('#ot-toolbar').click();
  await expect(page.locator('#ot-toolbar')).toHaveAttribute('aria-busy', 'false');

  // h1 标题 + 6 个段落 + 2 个浮动块段落 = 9 段原文，各得一个译文
  await expect(page.locator('.ot-translation')).toHaveCount(9);
  // 左栏 3 段 → 左栏内 3 个译文；右栏 3 段 → 右栏内 3 个译文（译文跟随各自栏）
  await expect(page.locator('.col').nth(0).locator('.ot-translation')).toHaveCount(3);
  await expect(page.locator('.col').nth(1).locator('.ot-translation')).toHaveCount(3);
});

test('plain container without semantic blocks: lines are translated separately', async ({
  page,
}) => {
  await page.goto('/tests/browser/plain-block-regression.html');
  await expect(page.locator('#ot-toolbar')).toBeVisible();
  await page.locator('#ot-toolbar').click();
  await expect(page.locator('#ot-toolbar')).toHaveAttribute('aria-busy', 'false');

  // h1 + 4 行 span 各自成块翻译（而不是整块合并成一段译文堆在容器末尾）
  await expect(page.locator('.ot-translation')).toHaveCount(5);
  // 每行译文紧跟对应原文行（行内 span 后插入的块级译文位于该行下方）
  // 原文行翻译后被标记 ot-translated；其紧随的兄弟即译文节点
  const lines = page.locator('.note span.ot-translated');
  await expect(lines).toHaveCount(4);
  await expect(lines.nth(0).locator('xpath=./following-sibling::*[1]')).toHaveClass(
    /ot-translation/,
  );
  await expect(lines.nth(2).locator('xpath=./following-sibling::*[1]')).toHaveClass(
    /ot-translation/,
  );
});

test('toolbar is draggable and keeps its position', async ({ page }) => {
  await page.goto('/tests/browser/selection-regression.html');
  const toolbar = page.locator('#ot-toolbar');
  await expect(toolbar).toBeVisible();

  const before = await toolbar.boundingBox();
  if (!before) throw new Error('toolbar missing');
  // 按住并拖拽（超过阈值视为拖拽而非点击）
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + 120, before.y + 80, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  const after = await toolbar.boundingBox();
  if (!after) throw new Error('toolbar missing after drag');
  expect(Math.round(after.x)).not.toBe(Math.round(before.x));
  expect(Math.round(after.y)).not.toBe(Math.round(before.y));

  // 刷新后位置保持（持久化）
  await page.reload();
  await expect(toolbar).toBeVisible();
  const restored = await toolbar.boundingBox();
  if (!restored) throw new Error('toolbar missing after reload');
  expect(Math.round(restored.x)).toBe(Math.round(after.x));
  expect(Math.round(restored.y)).toBe(Math.round(after.y));
});

test('gear button opens quick settings panel with live controls', async ({ page }) => {
  await page.goto('/tests/browser/selection-regression.html');
  await expect(page.locator('#ot-toolbar')).toBeVisible();

  await page.locator('#ot-settings-btn').click();
  const panel = page.locator('#ot-settings-panel');
  await expect(panel).toBeVisible();
  // 第 16 轮：标题已与完整设置统一为「好翻 · 设置」；保留「设置」关键词断言
  await expect(panel).toContainText('设置');

  // 目标语言选择器存在且含中文选项（option 在未展开的 select 中不可见，改查数量）
  const langSel = panel.getByRole('combobox', { name: '目标语言' });
  await expect(langSel).toBeVisible();
  await expect(langSel.locator('option[value="中文"]')).toHaveCount(1);

  // 关闭按钮可收起
  await panel.getByRole('button', { name: '关闭设置' }).click();
  await expect(panel).toBeHidden();
});

test('hover translation: hovering a paragraph shows a translation bubble', async ({ page }) => {
  await page.goto('/tests/browser/selection-regression.html');
  await page.locator('main p').first().hover();
  // 500ms 悬停延迟后出现气泡，内容为 mock 译文
  await expect(page.locator('#ot-hover-bubble')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#ot-hover-bubble')).toContainText('译文');
});

test('input translation: focusing a textarea shows translate button and result', async ({
  page,
}) => {
  await page.goto('/tests/browser/selection-regression.html');
  await page.evaluate(() => {
    const t = document.createElement('textarea');
    t.id = 'test-input';
    t.value = 'Hello world';
    document.body.appendChild(t);
    t.focus();
  });
  await expect(page.locator('#ot-input-btn')).toBeVisible();
  await page.locator('#ot-input-btn').click();
  await expect(page.locator('#ot-input-result')).toContainText('译文', { timeout: 5000 });
});

test('multi-column layout: translations stay in their own columns', async ({ page }) => {
  await page.goto('/tests/browser/layout-regression.html');
  await expect(page.locator('#ot-toolbar')).toBeVisible();
  await page.locator('#ot-toolbar').click();
  await expect(page.locator('#ot-toolbar')).toHaveAttribute('aria-busy', 'false');

  // 三列 6 段：每段译文紧跟原文（多列内 appendChild），
  // 总数 = h1 + 6列段 + 4卡 + 4行 + 2(apple-tile h2/p) + 1(flex行容器外) = 18
  await expect(page.locator('.ot-translation')).toHaveCount(18);
  // 每列段落内都有译文（而不是堆到列末尾）
  const col = page.locator('.cols3 p');
  for (let i = 0; i < 6; i++) {
    await expect(col.nth(i).locator('.ot-translation')).toHaveCount(1);
  }
});

test('grid cards: each card keeps translations inside itself', async ({ page }) => {
  await page.goto('/tests/browser/layout-regression.html');
  await expect(page.locator('#ot-toolbar')).toBeVisible();
  await page.locator('#ot-toolbar').click();
  await expect(page.locator('#ot-toolbar')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.card').nth(0).locator('.ot-translation')).toHaveCount(2);
  await expect(page.locator('.card').nth(1).locator('.ot-translation')).toHaveCount(1);
  await expect(page.locator('.card').nth(2).locator('.ot-translation')).toHaveCount(1);
});

test('quick settings panel: language and engine changes persist', async ({ page }) => {
  await page.goto('/tests/browser/selection-regression.html');
  await page.locator('#ot-settings-btn').click();
  const panel = page.locator('#ot-settings-panel');
  await expect(panel).toBeVisible();

  // 切换目标语言 → 写入配置存储
  await panel.getByRole('combobox', { name: '目标语言' }).selectOption('日本語');
  await page.waitForTimeout(300);
  const lang = await page.evaluate(
    async () => (await (window as any).chrome.storage.local.get('config')).config,
  );
  expect(lang.targetLang).toBe('日本語');

  // 切换引擎 → 写入配置存储
  await panel.getByRole('combobox', { name: '翻译引擎' }).selectOption('deepl');
  await page.waitForTimeout(300);
  const provider = await page.evaluate(
    async () => (await (window as any).chrome.storage.local.get('config')).config,
  );
  expect(provider.provider).toBe('deepl');
});

test('full settings panel opens as an in-page panel with the settings form', async ({ page }) => {
  await page.goto('/tests/browser/selection-regression.html');
  await page.locator('#ot-settings-btn').click();
  await page.locator('#ot-settings-panel').getByRole('button', { name: '打开完整设置' }).click();
  const full = page.locator('#ot-full-settings');
  await expect(full).toBeVisible();
  // 内联渲染完整设置表单（不再使用 iframe——网页无法嵌入扩展页面会被浏览器拦截）
  await expect(full.locator('.ot-form')).toHaveCount(1);
  await expect(full.locator('h2', { hasText: '翻译引擎' })).toBeVisible();
  await expect(full.locator('h2', { hasText: '语言' })).toBeVisible();
  await expect(full.locator('h2', { hasText: '译文显示' })).toBeVisible();
  await expect(full.locator('h2', { hasText: '功能开关' })).toBeVisible();
  // 样式已内嵌打包：表单字段带圆角卡片背景（iOS 分组样式生效）
  const bg = await full
    .locator('.ot-form-section')
    .first()
    .evaluate((el) => getComputedStyle(el).borderRadius);
  expect(bg).not.toBe('0px');
  // 关闭
  await full.getByRole('button', { name: '关闭完整设置' }).click();
  await expect(full).toBeHidden();
});

test('auto-translate site: page loads and starts translating automatically', async ({ page }) => {
  await page.goto('/tests/browser/selection-regression.html');
  // 预置"自动翻译此站"偏好后刷新（config 用 mock 预置的带 Key 配置，代表已配置用户）
  await page.evaluate(async () => {
    await (window as any).chrome.storage.local.set({
      autoSites: [location.host],
    });
  });
  await page.reload();
  await expect(page.locator('#ot-toolbar')).toBeVisible();
  // 自动开译：mock 记录到批量请求且状态条出现
  await expect
    .poll(async () => Number(await page.locator('html').getAttribute('data-batch-requests')))
    .toBeGreaterThan(0);
  await expect(page.locator('#ot-toolbar')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.ot-translation').first()).toBeVisible();
});

test('no API key: translation is gated by the setup guide and sends no requests', async ({ page }) => {
  await page.goto('/tests/browser/selection-regression.html');
  // 手动模式 + 无 Key（显式覆盖 mock 预置的带 Key 配置）后刷新
  await page.evaluate(async () => {
    await (window as any).chrome.storage.local.set({
      config: {
        provider: 'deepseek',
        apiKeys: {},
        model: 'deepseek-chat',
        sourceLang: '自动检测',
        targetLang: '中文',
        translateMode: 'manual',
      },
    });
  });
  await page.reload();
  const toolbar = page.locator('#ot-toolbar');
  await expect(toolbar).toBeVisible();
  // 手动点段落：被拦下 → 弹引导卡，不发任何请求
  await page.locator('#selection-source').click();
  await expect(page.locator('#ot-error-modal')).toBeVisible();
  await expect(page.locator('#ot-error-modal')).toContainText('还差一步就能开始翻译');
  await expect.poll(async () => Number(await page.locator('html').getAttribute('data-translation-calls'))).toBe(0);
  // 关闭引导卡（全屏模态会挡住后续点击），再验证整页翻译同样被拦下
  await page.locator('#ot-error-modal').getByRole('button', { name: '我知道了' }).click();
  await expect(page.locator('#ot-error-modal')).toHaveCount(0);
  await toolbar.click();
  await expect(page.locator('#ot-error-modal')).toBeVisible();
  await expect(page.locator('#ot-error-modal')).toContainText('还差一步就能开始翻译');
  await expect.poll(async () => Number(await page.locator('html').getAttribute('data-translation-calls'))).toBe(0);
});

test('settings panel follows dark color scheme with readable text', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/tests/browser/selection-regression.html');
  await page.locator('#ot-settings-btn').click();
  const panel = page.locator('#ot-settings-panel');
  await expect(panel).toBeVisible();
  const style = await panel.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, color: cs.color, backdrop: cs.backdropFilter };
  });
  // 深色系统：面板为深色玻璃底（Liquid Glass 为半透明 + 背景模糊）。
  // 关键不是「不透明」，而是底色足够深 + 文字足够亮（可读）。
  const rgba = style.bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  expect(rgba).not.toBeNull();
  const [r, g, b] = [Number(rgba![1]), Number(rgba![2]), Number(rgba![3])];
  expect(r).toBeLessThan(60);
  expect(g).toBeLessThan(60);
  expect(b).toBeLessThan(70);
  // 文字为浅色，保证在深底上可读
  const fg = style.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  expect(fg).not.toBeNull();
  expect(Number(fg![1])).toBeGreaterThan(180);
  // 玻璃生效：带背景模糊
  expect(style.backdrop).toContain('blur');
  await expect(panel.getByRole('combobox', { name: '目标语言' })).toBeVisible();
});

test('quick settings switches: apple toggles are clickable and persist', async ({ page }) => {
  await page.goto('/tests/browser/selection-regression.html');
  await page.locator('#ot-settings-btn').click();
  const panel = page.locator('#ot-settings-panel');
  await expect(panel).toBeVisible();

  // 自动翻译此站：默认关 → 点击开（input 覆盖整个开关区域，可直接点击）
  const autoInput = panel.getByRole('checkbox', { name: '自动翻译此站' });
  await expect(autoInput).not.toBeChecked();
  await autoInput.check({ force: true });
  await page.waitForTimeout(300);
  const sites = await page.evaluate(
    async () => (await (window as any).chrome.storage.local.get('autoSites')).autoSites,
  );
  const host = new URL(page.url()).host;
  expect(sites).toContain(host);
  await expect(autoInput).toBeChecked();

  // 悬停翻译开关存在且可切换
  const hoverInput = panel.getByRole('checkbox', { name: '悬停翻译' });
  await expect(hoverInput).toBeChecked(); // 默认开
  await hoverInput.uncheck({ force: true });
  await page.waitForTimeout(300);
  const cfg = await page.evaluate(
    async () => (await (window as any).chrome.storage.local.get('config')).config,
  );
  expect(cfg.hoverTranslate).toBe(false);

  // 开关视觉为 iOS 风格：绿色轨道 + 右侧圆圈
  const track = autoInput.locator('xpath=./following-sibling::*[1]');
  const trackBg = await track.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(trackBg).toMatch(/rgb\(52,\s*199,\s*89/); // #34c759 绿色
  const knob = track.locator('.knob');
  const knobTransform = await knob.evaluate((el) => getComputedStyle(el).transform);
  expect(knobTransform).not.toBe('none'); // 已右移（开启态）
});

test('quick settings panel: gear toggles, outside click and Escape close it', async ({ page }) => {
  await page.goto('/tests/browser/dom-regression.html');
  const gear = page.locator('#ot-settings-btn');
  const panel = page.locator('#ot-settings-panel');
  await expect(gear).toBeVisible();

  // 齿轮开关语义：打开 → 再点关闭
  await gear.click();
  await expect(panel).toBeVisible();
  await gear.click();
  await expect(panel).toHaveCount(0);

  // 点击面板外区域（页面空白处）关闭
  await gear.click();
  await expect(panel).toBeVisible();
  await page.mouse.click(10, 10);
  await expect(panel).toHaveCount(0);

  // Esc 关闭
  await gear.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // 关闭后面板内控件不再残留在 DOM 中
  await expect(page.locator('#ot-settings-panel select')).toHaveCount(0);
});

test('full settings modal: centered overlay with blur and sync with quick panel', async ({
  page,
}) => {
  await page.goto('/tests/browser/selection-regression.html');
  // 小面板先开启自动翻译（mock 预置 autoSites=[] → 初始关）
  await page.locator('#ot-settings-btn').click();
  const quickAuto = page
    .locator('#ot-settings-panel')
    .getByRole('checkbox', { name: '自动翻译此站' });
  await expect(quickAuto).not.toBeChecked();
  await quickAuto.check({ force: true });
  await page.waitForTimeout(300);

  // 快速面板修改翻译模式后，完整面板必须读取同一份最新配置。
  const quickMode = page
    .locator('#ot-settings-panel')
    .getByRole('combobox', { name: '翻译模式' });
  await quickMode.selectOption('manual');
  await page.waitForTimeout(300);

  // 打开大面板（小面板自动关闭）→ 本站开关读取到最新状态
  await page.locator('#ot-settings-panel').getByRole('button', { name: '打开完整设置' }).click();
  const full = page.locator('#ot-full-settings');
  await expect(full).toBeVisible();
  // 居中遮罩：全屏 fixed + 半透明背景（模糊遮罩）
  const pos = await full.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { position: cs.position, inset: cs.inset, bg: cs.backgroundColor };
  });
  expect(pos.position).toBe('fixed');
  expect(pos.inset).toBe('0px');
  expect(pos.bg).toMatch(/rgba\(0,\s*0,\s*0/); // 半透明遮罩

  await expect(full.locator('h2', { hasText: '本站' })).toBeVisible();
  const autoFull = full.locator('input[data-site-ctx="auto"]');
  await expect(autoFull).toBeChecked(); // 小面板 → 大面板一致
  await expect(full.getByRole('combobox', { name: '翻译模式' })).toHaveValue('manual');

  // 大面板关闭自动翻译 → 重新打开小面板 → 状态一致
  // 合成点击（避免 Playwright 等待可能的导航信号；change 事件照常触发）
  await autoFull.evaluate((el) => (el as HTMLInputElement).click());
  await page.waitForTimeout(300);

  // 面板布局：居中凸起（modal 容器存在、圆角、遮罩模糊）
  const modalInfo = await full.evaluate((host) => {
    const modal = host.shadowRoot?.querySelector('.modal');
    const mr = modal?.getBoundingClientRect();
    return {
      exists: Boolean(modal),
      centeredX: mr ? Math.abs(mr.x + mr.width / 2 - window.innerWidth / 2) < 8 : false,
      radius: modal ? getComputedStyle(modal).borderRadius : '',
      blur: getComputedStyle(host).backdropFilter,
    };
  });
  expect(modalInfo.exists).toBe(true);
  expect(modalInfo.centeredX).toBe(true);
  expect(modalInfo.radius).not.toBe('0px');
  expect(modalInfo.blur).toContain('blur');

  // 输入可用：展开高级设置 → 真实点击输入框（不关闭面板）→ 输入 → 保存
  await full.locator('details.ot-advanced-section summary').click();
  await expect(full.locator('details.ot-advanced-section[open]')).toBeVisible();
  const glossary = full.locator('textarea[data-f="customGlossary"]');
  await glossary.click();
  await expect(full).toBeVisible(); // 点击面板内控件不会关闭
  await page.keyboard.type('TestTerm=测试词');
  await page.waitForTimeout(500);
  const cfgIn = await page.evaluate(
    async () => (await (window as any).chrome.storage.local.get('config')).config,
  );
  expect(cfgIn.customGlossary).toContain('TestTerm=测试词');

  // 下拉可用：真实点击目标语言下拉并选择，面板保持打开
  const langSel = full.getByRole('combobox', { name: '目标语言' });
  await langSel.click();
  await expect(full).toBeVisible();
  await langSel.selectOption('日本語');
  await page.waitForTimeout(300);
  await expect(full).toBeVisible();
  const cfgLang = await page.evaluate(
    async () => (await (window as any).chrome.storage.local.get('config')).config,
  );
  expect(cfgLang.targetLang).toBe('日本語');

  // 面板内滚动可用：鼠标移入面板滚轮 → 面板内容滚动、页面不动
  await page.mouse.move(500, 300);
  const scrollBefore = await full.evaluate(
    (host) => host.shadowRoot?.querySelector('.ot-full-settings-body')?.scrollTop ?? 0,
  );
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(300);
  const scrollAfter = await full.evaluate(
    (host) => host.shadowRoot?.querySelector('.ot-full-settings-body')?.scrollTop ?? 0,
  );
  expect(scrollAfter).toBeGreaterThan(scrollBefore);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // 大屏开关视觉状态：默认开启 → is-checked 勾选样式存在（修复 shadow 查询盲区）
  const switchState = () =>
    full.evaluate((host) => {
      const shadow = host.shadowRoot;
      const labels = shadow?.querySelectorAll('label.ot-check');
      const state: Record<string, boolean> = {};
      labels?.forEach((l) => {
        const input = l.querySelector('input');
        const key = input?.getAttribute('data-f') || input?.getAttribute('data-site-ctx') || '';
        state[key] = l.classList.contains('is-checked');
      });
      return state;
    });
  const initial = await switchState();
  expect(initial.cacheEnabled).toBe(true); // 默认开启且视觉勾选
  // 点击可见的 label（checkbox 本体是 1×1 视觉隐藏输入，深层滚动时坐标不可靠）
  await full
    .locator('label.ot-check')
    .filter({ has: page.locator('input[data-f="cacheEnabled"]') })
    .click();
  await page.waitForTimeout(300);
  const afterClick = await switchState();
  expect(afterClick.cacheEnabled).toBe(false); // 点击后视觉关闭

  // 跨上下文同步：外部（模拟 popup）修改配置 → 大屏开关状态实时更新
  await page.evaluate(async () => {
    const cfg = await (window as any).chrome.storage.local.get('config');
    await (window as any).chrome.storage.local.set({
      config: { ...cfg.config, cacheEnabled: true, qualityCheck: false },
    });
  });
  await page.waitForTimeout(600);
  const synced = await switchState();
  expect(synced.cacheEnabled).toBe(true); // 外部开 → 大屏同步开
  expect(synced.qualityCheck).toBe(false); // 外部关 → 大屏同步关

  // 完整面板反向修改翻译模式，关闭后快速面板也必须立即更新。
  await full.getByRole('combobox', { name: '翻译模式' }).selectOption('auto');
  await page.waitForTimeout(300);

  await page.keyboard.press('Escape');
  await expect(full).toBeHidden();
  await page.locator('#ot-settings-btn').click();
  await expect(
    page.locator('#ot-settings-panel').getByRole('combobox', { name: '翻译模式' }),
  ).toHaveValue('auto');
  const quickAuto2 = page
    .locator('#ot-settings-panel')
    .getByRole('checkbox', { name: '自动翻译此站' });
  await expect(quickAuto2).not.toBeChecked(); // 大面板 → 小面板一致
});

test('stability: rapid translate/cancel/pause/resume cycles never hang', async ({ page }) => {
  await page.goto('/tests/browser/dom-regression.html');
  // 模拟较慢的模型响应，让加载态可被观察
  await page.locator('html').evaluate((el) => {
    el.dataset.batchDelays = JSON.stringify([500, 1500, 500, 1500, 500, 1500]);
  });
  const toolbar = page.locator('#ot-toolbar');
  await expect(toolbar).toBeVisible();

  // 三轮：翻译开始（加载态）→ 取消 → 再翻译 → 完成
  for (let round = 0; round < 3; round++) {
    await toolbar.click();
    await expect(toolbar).toHaveAttribute('aria-busy', 'true');
    await toolbar.click(); // 取消
    await expect(toolbar).toHaveAttribute('aria-busy', 'false');
  }

  // 暂停本站 → 工具栏消失且无残留译文
  await page.evaluate(async () => {
    await (window as any).chrome.storage.local.set({ disabledSites: [location.host] });
  });
  await expect(toolbar).toBeHidden({ timeout: 8000 });
  await expect(page.locator('.ot-translation')).toHaveCount(0);

  // 恢复本站 → 工具栏回来，翻译仍可用
  await page.evaluate(async () => {
    await (window as any).chrome.storage.local.set({ disabledSites: [] });
  });
  await expect(toolbar).toBeVisible({ timeout: 8000 });
  await toolbar.click();
  await expect(toolbar).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });
  await expect(page.locator('.ot-translation').first()).toBeVisible({ timeout: 60000 });
});

test('toggle translations: hide/show without re-translating (0 extra requests)', async ({ page }) => {
  await page.goto('/tests/browser/dom-regression.html');
  const toolbar = page.locator('#ot-toolbar');
  await expect(toolbar).toBeVisible();

  // 先翻译出译文（明确点主按钮：胶囊工具栏变宽后，容器中心已不是主按钮）
  const mainBtn = page.locator('#ot-translate-btn');
  await mainBtn.click();
  await expect(toolbar).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });
  const translations = page.locator('.ot-translation');
  await expect(translations.first()).toBeVisible({ timeout: 60000 });
  const count = await translations.count();
  expect(count).toBeGreaterThan(0);
  const firstText = (await translations.first().textContent())?.trim();

  // 记录请求数：切换显隐不应产生任何新的翻译请求
  const requestsBefore = await page.evaluate(
    () => (window as any).__haofanRequestCount ?? 0,
  );

  // 点眼睛按钮隐藏
  const hideBtn = page.locator('#ot-hide-btn');
  await expect(hideBtn).toBeVisible();
  await hideBtn.click();
  await expect(page.locator('html')).toHaveClass(/ot-hide-translations/);
  // 译文节点仍在 DOM（未被删除），只是不可见
  expect(await translations.count()).toBe(count);
  await expect(translations.first()).toBeHidden();

  // 再点恢复：译文内容必须与隐藏前一致（证明没有重新翻译）
  await hideBtn.click();
  await expect(translations.first()).toBeVisible();
  expect((await translations.first().textContent())?.trim()).toBe(firstText);
  await expect(page.locator('html')).not.toHaveClass(/ot-hide-translations/);

  // 隐藏期间没有新增请求（省 Token 的核心保证）
  const requestsAfter = await page.evaluate(
    () => (window as any).__haofanRequestCount ?? 0,
  );
  expect(requestsAfter).toBe(requestsBefore);
});

// ===== Round 17：显隐状态与新建/收起译文解耦（P0 状态失步）=====
// 此前「已隐藏译文」时：
//  ① SPA 动态新增/滚动懒加载/重译产生的译文节点自带 display:block !important
//    （内联压过外部 CSS 的 !important 兜底）会突然显示，按钮却仍处于「已隐藏」；
//  ② 点主按钮收起全部译文后隐藏态不复位，再点翻译的新译文全部处于隐藏态，
//    用户以为翻译没生效。
// 场景 A 验证 ①（隐藏态下动态新增内容必须跟随隐藏）；
// 场景 B 验证 ②（收起=复位隐藏态，再翻译立即可见）。
test('round17: translations inserted while hidden stay hidden (SPA/lazy content)', async ({
  page,
}) => {
  await page.goto('/tests/browser/dom-regression.html');
  const toolbar = page.locator('#ot-toolbar');
  await expect(toolbar).toBeVisible();
  const mainBtn = page.locator('#ot-translate-btn');
  const hideBtn = page.locator('#ot-hide-btn');
  const html = page.locator('html');

  // ① 整页翻译（可见态）
  await mainBtn.click();
  await expect(toolbar).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });
  const translations = page.locator('.ot-translation');
  await expect(translations.first()).toBeVisible({ timeout: 60000 });

  // ② 隐藏全部译文 → 现有译文全部不可见（节点保留，未重新翻译）
  await hideBtn.click();
  await expect(html).toHaveClass(/ot-hide-translations/);
  await expect(translations.first()).toBeHidden();

  // ③ 隐藏态下 SPA 动态新增内容（懒加载/虚拟列表同理）→ 新译文必须跟随隐藏。
  //    P0：修复前新节点自带 display:block !important 会直接冒出来。
  await page.getByRole('button', { name: 'Add dynamic content' }).click();
  await expect
    .poll(async () => await page.locator('#processed-parent .ot-translation').count())
    .toBeGreaterThan(0);
  const dynamicTranslation = page.locator('#processed-parent .ot-translation').first();
  await expect(dynamicTranslation).toBeHidden();

  // ④ 恢复显示 → 新旧译文一起可见（隐藏/恢复不产生新请求，内容一致）
  await hideBtn.click();
  await expect(html).not.toHaveClass(/ot-hide-translations/);
  await expect(translations.first()).toBeVisible();
  await expect(dynamicTranslation).toBeVisible();
});

test('round17: clearing all translations also resets the hidden state', async ({ page }) => {
  await page.goto('/tests/browser/dom-regression.html');
  const toolbar = page.locator('#ot-toolbar');
  await expect(toolbar).toBeVisible();
  const mainBtn = page.locator('#ot-translate-btn');
  const hideBtn = page.locator('#ot-hide-btn');
  const html = page.locator('html');

  // ① 翻译 → 隐藏（进入「已隐藏译文」态）
  await mainBtn.click();
  await expect(toolbar).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });
  const translations = page.locator('.ot-translation');
  await expect(translations.first()).toBeVisible({ timeout: 60000 });
  await hideBtn.click();
  await expect(html).toHaveClass(/ot-hide-translations/);

  // ② 主按钮收起全部译文（有译文时主按钮语义=收起）→ 收起必须同时复位隐藏态。
  //    P0：修复前隐藏态残留，「收起 → 再翻译」的新译文全躲在隐藏态。
  await mainBtn.click();
  await expect(html).not.toHaveClass(/ot-hide-translations/);
  await expect(translations).toHaveCount(0);

  // ③ 再点主按钮重新翻译 → 新译文立即可见（核心回归断言）
  await mainBtn.click();
  await expect(toolbar).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });
  await expect(translations.first()).toBeVisible({ timeout: 60000 });
  await expect(html).not.toHaveClass(/ot-hide-translations/);
});

// 空态人体工学：页面还没有译文时，隐藏按钮是无效动作——直接进隐藏态会让
// 按钮变暗（opacity 0.45）却没有可隐藏内容，用户困惑。应引导先翻译。
test('round17: hiding with no translations yet guides the user instead of toggling', async ({
  page,
}) => {
  await page.goto('/tests/browser/dom-regression.html');
  const toolbar = page.locator('#ot-toolbar');
  await expect(toolbar).toBeVisible();
  const hideBtn = page.locator('#ot-hide-btn');
  const html = page.locator('html');

  // 页面还没有任何译文（未点过翻译）时点隐藏 → 不进隐藏态，给引导提示
  await hideBtn.click();
  await expect(html).not.toHaveClass(/ot-hide-translations/);
  const status = page.locator('#ot-status');
  await expect(status).toBeVisible();
  await expect(status).toContainText('还没有译文');
});

test('quick settings shows keyboard shortcuts so users can discover them', async ({ page }) => {
  await page.goto('/tests/browser/selection-regression.html');
  await page.locator('#ot-settings-btn').click();
  const panel = page.locator('#ot-settings-panel');
  await expect(panel).toBeVisible();
  // 快捷键常驻提示：Alt+T 翻译本页、Alt+S 显示/隐藏译文
  const hint = panel.locator('.kbd-hint');
  await expect(hint).toBeVisible();
  const text = (await hint.textContent()) ?? '';
  expect(text).toContain('Alt');
  expect(text).toContain('T');
  expect(text).toContain('S');
  expect(text).toContain('翻译本页');
  expect(text).toContain('隐藏译文');
  // 提示在面板底部且在「打开完整设置」之后
  const box = await hint.boundingBox();
  const btn = await panel.getByRole('button', { name: '打开完整设置' }).boundingBox();
  expect(box).not.toBeNull();
  expect(btn).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(btn!.y);
});

test('translation layout: source above, translation below, clearly separated', async ({ page }) => {
  await page.goto('/tests/browser/dom-regression.html');
  await page.locator('#ot-translate-btn').click();
  await expect(page.locator('#ot-toolbar')).toHaveAttribute('aria-busy', 'false', {
    timeout: 60000,
  });
  const first = page.locator('.ot-translation').first();
  await expect(first).toBeVisible({ timeout: 60000 });

  // ① 位置关系：译文在原文下方（宿主元素在 DOM 中位于原文之后且垂直位置更低）
  const geo = await first.evaluate((el) => {
    const host = el as HTMLElement;
    const prev = host.previousElementSibling ?? host.parentElement;
    const r = host.getBoundingClientRect();
    const p = prev?.getBoundingClientRect();
    const cs = getComputedStyle(host);
    return {
      top: r.top,
      prevBottom: p ? p.bottom : null,
      marginTop: cs.marginTop,
      marginBottom: cs.marginBottom,
    };
  });
  if (geo.prevBottom !== null) {
    expect(geo.top).toBeGreaterThanOrEqual(geo.prevBottom - 1);
  }
  // ② 垂直呼吸：与原文/下一段有明确间距（此前仅 2px/5px 会并拢）
  expect(Number.parseFloat(geo.marginBottom)).toBeGreaterThanOrEqual(8);

  // ③ 译文锚点：左侧竖线，让"哪行是译文"一眼可辨
  const line = await first
    .locator('.text')
    .evaluate((el) => getComputedStyle(el).borderLeftWidth);
  expect(Number.parseFloat(line)).toBeGreaterThanOrEqual(2);
});

// ===== 0.2.2 第一阶段缺口补全：对照模式 / 排版自定义 / 网站规则 =====

test('dual mode: translation-only hides source, hover reveals it, zero re-translation', async ({
  page,
}) => {
  await page.goto('/tests/browser/dom-regression.html');
  await page.locator('#ot-translate-btn').click();
  await expect(page.locator('#ot-toolbar')).toHaveAttribute('aria-busy', 'false', {
    timeout: 60000,
  });
  const firstTranslation = page.locator('.ot-translation').first();
  await expect(firstTranslation).toBeVisible({ timeout: 60000 });

  const callsBefore = Number(
    await page.locator('html').getAttribute('data-translation-calls'),
  );

  // 切换为「只显示译文」：config 更新 → watch 就地应用（不重译）
  await page.evaluate(async () => {
    const { config } = await (window as any).chrome.storage.local.get('config');
    await (window as any).chrome.storage.local.set({
      config: { ...config, dualMode: 'translation-only' },
    });
  });
  await page.waitForTimeout(400);

  // 原文被隐藏（透明度 0），译文仍在
  const sourceHidden = await firstTranslation.evaluate((el) => {
    const anchor = (el as HTMLSpanElement & { otAnchor?: Element }).otAnchor as HTMLElement;
    return anchor ? getComputedStyle(anchor).opacity : '';
  });
  expect(sourceHidden).toBe('0');
  await expect(firstTranslation).toBeVisible();

  // 悬停译文 → 原文临时恢复（事件委托在锚点上加 hover 类）
  await firstTranslation.hover();
  await page.waitForTimeout(150);
  const sourceRevealed = await firstTranslation.evaluate((el) => {
    const anchor = (el as HTMLSpanElement & { otAnchor?: Element }).otAnchor as HTMLElement;
    return anchor ? anchor.classList.contains('ot-dual-source-hover') : false;
  });
  expect(sourceRevealed).toBe(true);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(150);

  // 0 重译：切换对照模式不产生任何新请求
  const callsAfter = Number(
    await page.locator('html').getAttribute('data-translation-calls'),
  );
  expect(callsAfter).toBe(callsBefore);
});

test('dual mode: hover-original highlights source, zero re-translation', async ({ page }) => {
  await page.goto('/tests/browser/dom-regression.html');
  await page.locator('#ot-translate-btn').click();
  await expect(page.locator('#ot-toolbar')).toHaveAttribute('aria-busy', 'false', {
    timeout: 60000,
  });
  const firstTranslation = page.locator('.ot-translation').first();
  await expect(firstTranslation).toBeVisible({ timeout: 60000 });

  const callsBefore = Number(
    await page.locator('html').getAttribute('data-translation-calls'),
  );

  await page.evaluate(async () => {
    const { config } = await (window as any).chrome.storage.local.get('config');
    await (window as any).chrome.storage.local.set({
      config: { ...config, dualMode: 'hover-original' },
    });
  });
  await page.waitForTimeout(400);

  // 原文默认正常显示（没有被隐藏）
  const sourceVisible = await firstTranslation.evaluate((el) => {
    const anchor = (el as HTMLSpanElement & { otAnchor?: Element }).otAnchor as HTMLElement;
    return anchor ? getComputedStyle(anchor).opacity : '';
  });
  expect(sourceVisible).toBe('1');

  // 悬停译文 → 原文高亮背景类出现
  await firstTranslation.hover();
  await page.waitForTimeout(150);
  const highlighted = await firstTranslation.evaluate((el) => {
    const anchor = (el as HTMLSpanElement & { otAnchor?: Element }).otAnchor as HTMLElement;
    return anchor ? anchor.classList.contains('ot-dual-source-hover-active') : false;
  });
  expect(highlighted).toBe(true);

  const callsAfter = Number(
    await page.locator('html').getAttribute('data-translation-calls'),
  );
  expect(callsAfter).toBe(callsBefore);
});

test('translation typography: custom size/line-height/opacity/color apply without re-translation', async ({
  page,
}) => {
  await page.goto('/tests/browser/dom-regression.html');
  await page.locator('#ot-translate-btn').click();
  await expect(page.locator('#ot-toolbar')).toHaveAttribute('aria-busy', 'false', {
    timeout: 60000,
  });
  const firstTranslation = page.locator('.ot-translation').first();
  await expect(firstTranslation).toBeVisible({ timeout: 60000 });

  const callsBefore = Number(
    await page.locator('html').getAttribute('data-translation-calls'),
  );

  // 设置四项自定义 → watch 就地更新 CSS 变量
  await page.evaluate(async () => {
    const { config } = await (window as any).chrome.storage.local.get('config');
    await (window as any).chrome.storage.local.set({
      config: {
        ...config,
        translationFontSize: 18,
        translationLineHeight: 2,
        translationOpacity: 1,
        translationColor: '#e11d48',
      },
    });
  });
  await page.waitForTimeout(400);

  const vars = await firstTranslation.evaluate((el) => {
    const host = el as HTMLElement;
    const cs = getComputedStyle(host);
    return {
      fontSize: cs.getPropertyValue('--ot-font-size').trim(),
      lineHeight: cs.getPropertyValue('--ot-line-height').trim(),
      opacity: cs.getPropertyValue('--ot-opacity').trim(),
      color: cs.getPropertyValue('--ot-color').trim(),
    };
  });
  expect(vars.fontSize).toBe('18px');
  expect(vars.lineHeight).toBe('2');
  expect(vars.opacity).toBe('1');
  expect(vars.color).toBe('#e11d48');

  // 消费变量的实际文本样式也更新（Shadow DOM 内 .text）
  const textStyle = await firstTranslation.locator('.text').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { size: cs.fontSize, color: cs.color, lineHeight: cs.lineHeight };
  });
  expect(textStyle.size).toBe('18px');
  expect(textStyle.color).toBe('rgb(225, 29, 72)');
  expect(Number.parseFloat(textStyle.lineHeight)).toBeGreaterThanOrEqual(2);

  // 0 重译：排版变化不产生新请求
  const callsAfter = Number(
    await page.locator('html').getAttribute('data-translation-calls'),
  );
  expect(callsAfter).toBe(callsBefore);
});

test('site rules: always-site whitelist forces auto translation in manual mode', async ({
  page,
}) => {
  await page.goto('/tests/browser/selection-regression.html');
  // 预置「手动模式 + 白名单含本站」后刷新：白名单应覆盖全局手动模式强制开译
  await page.evaluate(async () => {
    await (window as any).chrome.storage.local.set({
      config: { provider: 'deepseek', apiKeys: { deepseek: 'test-key' }, translateMode: 'manual' },
      alwaysSites: [location.host],
    });
  });
  await page.reload();
  const toolbar = page.locator('#ot-toolbar');
  await expect(toolbar).toBeVisible();
  // 白名单命中 → 强制整页自动翻译
  await expect
    .poll(async () => Number(await page.locator('html').getAttribute('data-batch-requests')))
    .toBeGreaterThan(0);
  await expect(page.locator('.ot-translation').first()).toBeVisible({ timeout: 60000 });
});

test('site rules: never-site exclusion pauses even when whitelisted', async ({ page }) => {
  await page.goto('/tests/browser/selection-regression.html');
  // 本站同时命中敏感列表（URL 子串）与白名单：敏感优先 → 完全暂停
  await page.evaluate(async () => {
    await (window as any).chrome.storage.local.set({
      alwaysSites: [location.host],
      neverSites: ['selection-regression'],
    });
  });
  await page.reload();
  // 暂停站：工具栏与整页翻译都不出现
  await expect(page.locator('#ot-toolbar')).toHaveCount(0);
  await expect.poll(async () => Number(await page.locator('html').getAttribute('data-batch-requests'))).toBe(0);
  // 从敏感列表移除后恢复
  await page.evaluate(async () => {
    await (window as any).chrome.storage.local.set({ neverSites: [] });
  });
  await expect(page.locator('#ot-toolbar')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('.ot-translation').first()).toBeVisible({ timeout: 60000 });
});

test('fallback to a keyless provider shows a one-time status notice', async ({ page }) => {
  await page.goto('/tests/browser/selection-regression.html');
  // mock 主引擎失败后回退免 Key 通道：响应携带 usedProvider='mymemory'，
  // 且用户配置主引擎为 deepseek → 整页翻译完成提示里应合并「已用 MyMemory 翻译」。
  await page.locator('html').evaluate((element) => {
    element.dataset.mockUsedProvider = 'mymemory';
  });
  const toolbar = page.locator('#ot-toolbar');
  await expect(toolbar).toBeVisible();
  await toolbar.click();
  await expect(toolbar).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.ot-translation').first()).toBeVisible({ timeout: 60000 });
  // 状态条出现降级文案（合并进整页完成提示）
  await expect(page.locator('#ot-status')).toContainText('已用 MyMemory 翻译', { timeout: 60000 });
});

test('single translation fallback shows an immediate status notice', async ({ page }) => {
  await page.goto('/tests/browser/selection-regression.html');
  // 单条交互（划词翻译）：不在整页任务中 → 直接弹一次性降级提示
  await page.locator('html').evaluate((element) => {
    element.dataset.mockUsedProvider = 'mymemory';
  });
  await page.getByRole('button', { name: 'Create selection' }).click();
  const trigger = page.locator('#ot-selection-ui').getByRole('button', { name: '翻译选中内容' });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.locator('#ot-selection-ui')).toContainText('启用双重身份验证');
  await expect(page.locator('#ot-status')).toContainText('主引擎不可用，已切换至 MyMemory 翻译', {
    timeout: 60000,
  });
});

test('fresh install defaults to the keyless MyMemory engine', async ({ page }) => {
  await page.goto('/tests/browser/selection-regression.html');
  // 清空已存配置 = 全新安装：normalizeConfig 回退 DEFAULT_CONFIG，
  // 应得到免 Key 的 MyMemory 引擎（无需 Key、不弹引导、直接可用）。
  await page.evaluate(async () => {
    await (window as any).chrome.storage.local.set({ config: {} });
  });
  await page.reload();
  const toolbar = page.locator('#ot-toolbar');
  await expect(toolbar).toBeVisible();
  await toolbar.click();
  await expect(toolbar).toHaveAttribute('aria-busy', 'false');
  // 没有 API Key 也能完成翻译（MyMemory 免 Key，guardSetupGate 不拦截）
  await expect(page.locator('.ot-translation').first()).toBeVisible({ timeout: 60000 });
  // 无引导卡（免 Key 不需要配置提示），状态条无降级文案
  await expect(page.locator('#ot-error-modal')).toHaveCount(0);
  await expect(page.locator('#ot-status')).not.toContainText('主引擎不可用');
});

// ===== Round 15：欢迎引导「免费体验」按钮 =====
// v0.2.4 起 Google 免 Key 已下线并从引擎注册表移除；此按钮此前仍一键切到 google
// （不存在的引擎），新用户点击后必然翻译失败。修复后必须切到内置免 Key 通道 MyMemory。
test('round15: welcome free button switches to the built-in keyless engine (not retired Google)', async ({
  page,
}) => {
  await page.goto('/tests/browser/popup-regression.html');
  // 制造「全新用户」：无任何 Key + 未完成引导 → 欢迎面板出现
  await page.evaluate(async () => {
    await (window as any).chrome.storage.local.set({
      config: {},
      onboardingDone: false,
    });
  });
  await page.reload();
  const welcome = page.locator('#ot-welcome');
  await expect(welcome).toBeVisible();
  // 按钮文案与引导说明已同步为 MyMemory
  const freeBtn = page.getByRole('button', { name: '免费体验 · 不填 Key' });
  await expect(freeBtn).toBeVisible();
  await expect(page.locator('.ot-welcome-free-note')).toContainText('MyMemory');
  await freeBtn.click();
  // 点击后：存储里的 provider 必须是 mymemory（而不是已下线的 google）
  await expect
    .poll(async () =>
      page.evaluate(
        async () => (await (window as any).chrome.storage.local.get('config')).config?.provider,
      ),
    )
    .toBe('mymemory');
  // baseUrl 必须是 MyMemory 预设端点，不能是 translate.googleapis.com
  await expect
    .poll(async () =>
      page.evaluate(
        async () => (await (window as any).chrome.storage.local.get('config')).config?.baseUrl,
      ),
    )
    .toContain('mymemory.translated.net');
  // 欢迎面板关闭
  await expect(welcome).toBeHidden();
  // 成功提示
  await expect(page.locator('#ot-out')).toContainText('MyMemory');
});

// ===== 第 10 轮「最终版」：UI 反馈与实用功能回归 =====
test('round10: primary translate button has hover and press feedback', async ({ page }) => {
  await page.goto('/tests/browser/selection-regression.html');
  const btn = page.locator('#ot-translate-btn');
  await expect(btn).toBeVisible();

  // 默认态：渐变蓝底（非写死单色）
  const initial = await btn.evaluate((el) => (el as HTMLElement).style.background);
  expect(initial).toContain('linear-gradient');

  // hover：提亮渐变 + 上浮 + 阴影增强（浏览器将 hex 解析为 rgb 返回）
  await btn.hover();
  const hovered = await btn.evaluate((el) => {
    const s = (el as HTMLElement).style;
    return { bg: s.background, transform: s.transform, shadow: s.boxShadow };
  });
  expect(hovered.bg).toContain('rgb(61, 153, 255)');
  expect(hovered.transform).toBe('translateY(-1px)');
  expect(hovered.shadow).toContain('0.45');

  // mouseleave：还原（鼠标移到页面空白处离开按钮）
  await page.mouse.move(10, 10);
  const restored = await btn.evaluate((el) => {
    const s = (el as HTMLElement).style;
    return { bg: s.background, transform: s.transform };
  });
  expect(restored.bg).toContain('rgb(43, 140, 255)');
  expect(restored.transform).toBe('translateY(0px)'); // 浏览器序列化为 0px
});

test('round10: loading background follows theme instead of hardcoded color', async ({
  page,
}) => {
  await page.goto('/tests/browser/selection-regression.html');
  const btn = page.locator('#ot-translate-btn');
  await expect(btn).toBeVisible();

  // mock hold 模式：批次永不返回（模拟慢网络），加载态可持续观测
  await page.locator('html').evaluate((element) => {
    element.dataset.batchMode = 'hold';
  });
  // 触发整页翻译 → 加载态背景不再写死 #8fb8ef，而是主题 accent 色
  await page.locator('#ot-toolbar').click();
  await expect(btn).toHaveAttribute('aria-busy', 'true', { timeout: 5000 });
  const loadingBg = await btn.evaluate((el) => (el as HTMLElement).style.background);
  expect(loadingBg).not.toBe('#8fb8ef');
  // 主题 accent 色（浅色主题下为蓝色调，非旧写死的灰蓝）
  expect(loadingBg).toContain('rgb(0, 122, 255)');
  // 取消翻译恢复空闲态（点击工具栏取消）
  await page.locator('#ot-toolbar').click();
  await expect(btn).toHaveAttribute('aria-busy', 'false', { timeout: 5000 });
});

test('round10: status bar text is left-aligned for long multiline notices', async ({
  page,
}) => {
  await page.goto('/tests/browser/selection-regression.html');
  // 整页翻译完成后状态条常驻，检查其文本对齐
  await page.locator('#ot-toolbar').click();
  await expect(page.locator('#ot-status')).toBeVisible({ timeout: 60000 });
  const align = await page.locator('#ot-status').evaluate((el) => getComputedStyle(el).textAlign);
  expect(align).toBe('left');
});

test('round10: quick settings dropdown marks providers missing an API key', async ({
  page,
}) => {
  await page.goto('/tests/browser/selection-regression.html');
  await page.locator('#ot-settings-btn').click();
  const panel = page.locator('#ot-settings-panel');
  await expect(panel).toBeVisible();
  const engine = panel.getByRole('combobox', { name: '翻译引擎' });

  // 免 Key 引擎：标注「免 Key」
  const mymemory = engine.locator('option[value="mymemory"]');
  await expect(mymemory).toContainText('（免 Key）');

  // mock 预置了 deepseek 的 Key：标注「已配 Key」，无警示类
  const deepseek = engine.locator('option[value="deepseek"]');
  await expect(deepseek).toContainText('（已配 Key）');

  // 未配 Key 的引擎：标注「未配 Key」且 option 带 data-missing-key
  const openai = engine.locator('option[value="openai"]');
  await expect(openai).toContainText('（未配 Key）');
  await expect(openai).toHaveAttribute('data-missing-key', 'true');

  // 当前选中 deepseek（已配）→ 下拉无警示类
  await expect(engine).not.toHaveClass(/missing-key/);

  // 切到未配 Key 引擎 → 下拉加 missing-key 警示类（橙色边框提示去填 Key）
  await engine.selectOption('openai');
  await expect(engine).toHaveClass(/missing-key/);
});

// ===== Round 16：快速设置与完整设置一致化 =====
// 此前快速设置面板的引擎下拉是扁平列表，完整设置面板已按
// 「免 Key 体验 / 接自己的 API」分组——同一个配置两个入口长得不一样。
// 修复：快速设置同样按 optgroup 分组，且分组文案与完整设置完全一致。
test('round16: quick settings groups providers like the full settings panel', async ({
  page,
}) => {
  await page.goto('/tests/browser/selection-regression.html');
  await page.locator('#ot-settings-btn').click();
  const panel = page.locator('#ot-settings-panel');
  await expect(panel).toBeVisible();

  const engine = panel.getByRole('combobox', { name: '翻译引擎' });
  const groups = engine.locator('optgroup');
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toHaveAttribute(
    'label',
    /免 Key 体验（零配置，装完就能用）/,
  );
  await expect(groups.nth(1)).toHaveAttribute('label', /接自己的 API（更准更快）/);

  // 免 Key 组：MyMemory / Apertium / Ollama 本地
  await expect(groups.nth(0)).toContainText('MyMemory');
  await expect(groups.nth(0)).toContainText('Apertium');
  await expect(groups.nth(0)).toContainText('Ollama');
  // 需 Key 组：DeepSeek（mock 已配 Key）
  await expect(groups.nth(1)).toContainText('DeepSeek');
  await expect(groups.nth(1)).toContainText('OpenAI');

  // 原有标注行为不回归：option 仍带「免 Key / 已配 Key / 未配 Key」标注
  await expect(engine.locator('option[value="mymemory"]')).toContainText('（免 Key）');
  await expect(engine.locator('option[value="deepseek"]')).toContainText('（已配 Key）');
  await expect(engine.locator('option[value="openai"]')).toContainText('（未配 Key）');
  await expect(engine.locator('option[value="openai"]')).toHaveAttribute(
    'data-missing-key',
    'true',
  );

  // 面板标题与完整设置统一（不再叫「快速设置」）
  await expect(panel).toContainText('好翻 · 设置');
});

test('round10: failed batch marks paragraphs retryable with completion hint', async ({
  page,
}) => {
  await page.goto('/tests/browser/selection-regression.html');
  // mock 返回 batchMode='fail'：整批请求失败（可重试的网络错误）
  await page.locator('html').evaluate((element) => {
    element.dataset.batchMode = 'fail';
  });
  const toolbar = page.locator('#ot-toolbar');
  await expect(toolbar).toBeVisible();
  await toolbar.click();
  await expect(toolbar).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });

  // 失败段落在完成文案中提示可重试
  await expect(page.locator('#ot-status')).toContainText('失败', { timeout: 60000 });
  await expect(page.locator('#ot-status')).toContainText('滚动或点击失败段落可重试', {
    timeout: 60000,
  });
});

// ===== round11：设置面板排版重构（单列一行一项 / 对比度 / 微信式滑块）=====
// 根因备忘：options.css 里的 @media 看的是浏览器窗口宽度，而页内完整设置面板
// 宽度固定 640px 且与窗口无关。旧的「≥1280px 双栏」「≥900px 三列」规则在宽屏打开
// 面板时会把面板拆成两列、单格压到 90px，导致文字重叠与卡片错位。

async function openFullSettings(page: import('@playwright/test').Page) {
  await page.locator('#ot-toolbar').waitFor();
  await page.locator('#ot-settings-btn').click();
  await page.locator('#ot-settings-panel').getByRole('button', { name: '打开完整设置' }).click();
  const full = page.locator('#ot-full-settings');
  await expect(full).toBeVisible();
  return full;
}

test('round11: full settings panel is a single-column list with one item per row', async ({
  page,
}) => {
  // 故意用宽视口：旧版正是这里触发双栏、把 640px 面板挤坏
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/tests/browser/selection-regression.html');
  const full = await openFullSettings(page);

  const metrics = await full.evaluate((host) => {
    const root = (host as HTMLElement).shadowRoot!;
    const countTracks = (value: string) =>
      value.split(' ').filter((part) => /px$/.test(part)).length;
    const form = root.querySelector('.ot-form') as HTMLElement;
    const grid = root.querySelector('.ot-field-grid') as HTMLElement;
    const fields = Array.from(root.querySelectorAll('.ot-field')) as HTMLElement[];
    const body = root.querySelector('.ot-full-settings-body') as HTMLElement;
    return {
      formDisplay: getComputedStyle(form).display,
      gridTracks: countTracks(getComputedStyle(grid).gridTemplateColumns),
      fieldTracks: countTracks(getComputedStyle(fields[0]).gridTemplateColumns),
      widths: [...new Set(fields.map((field) => Math.round(field.getBoundingClientRect().width)))],
      overflowX: body.scrollWidth - body.clientWidth,
    };
  });

  expect(metrics.formDisplay).toBe('block'); // 表单本身不再分栏
  expect(metrics.gridTracks).toBe(1); // 字段容器恒为单列
  expect(metrics.fieldTracks).toBe(2); // 每行 = 标签列 + 控件列
  expect(metrics.widths).toHaveLength(1); // 所有字段等宽，左边缘对齐
  expect(metrics.overflowX).toBe(0); // 不出现横向溢出
});

test('round11: missing-key guide is readable in dark mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/tests/browser/selection-regression.html');
  const full = await openFullSettings(page);

  // 「自定义（OpenAI 兼容）」需要 Key 且当前未配置 → 引导条必须出现
  await full.locator('select[data-f="provider"]').selectOption('custom');
  const guide = full.locator('[data-f="keyGuide"]');
  await expect(guide).toBeVisible();
  await expect(guide).toContainText('此引擎需要 API Key');

  // 旧 bug：样式引用了未定义的 --color-text → 回退近黑 #1d1d1f，
  // 深色底上文字与背景同色，整条只剩一个「空绿框」。
  const luminance = await guide.evaluate((element) => {
    const toLinear = (value: number) =>
      value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    const channels = (getComputedStyle(element).color.match(/[\d.]+/g) || [])
      .slice(0, 3)
      .map((channel) => toLinear(Number(channel) / 255));
    const [r = 0, g = 0, b = 0] = channels;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  });
  expect(luminance).toBeGreaterThan(0.5); // 深色主题下必须是亮色文字
});

test('round11: switches render as sliding toggles', async ({ page }) => {
  await page.goto('/tests/browser/selection-regression.html');
  const full = await openFullSettings(page);

  const autoSite = full.locator('#ot-full-auto');
  await expect(autoSite).toBeAttached();

  const track = await autoSite.evaluate((element) => {
    const style = getComputedStyle(element, '::after');
    return { width: style.width, height: style.height, radius: style.borderRadius };
  });
  expect(track.width).toBe('46px');
  expect(track.height).toBe('28px');
  expect(track.radius).toBe('999px'); // 胶囊轨道（不是圆形勾选框）

  const knobBefore = await autoSite.evaluate(
    (element) => getComputedStyle(element, '::before').transform,
  );
  await autoSite.click();
  await expect(autoSite).toHaveClass(/is-checked/); // 走向由 storage 同步驱动
  // 圆点有 0.2s 过渡动画：立即读会拿到起始值，必须轮询等动画结束
  await expect
    .poll(async () =>
      autoSite.evaluate((element) => getComputedStyle(element, '::before').transform),
    )
    .not.toBe(knobBefore);
});

test('round11: field hint never overlaps its control', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/tests/browser/selection-regression.html');
  const full = await openFullSettings(page);

  // 旧版「翻译模式」的说明文字直接压在下拉框上
  const modeField = full.locator('.ot-field', { hasText: '翻译模式' });
  const hintBox = await modeField.locator('span').boundingBox();
  const controlBox = await modeField.locator('select').boundingBox();
  expect(hintBox).not.toBeNull();
  expect(controlBox).not.toBeNull();

  const hint = hintBox!;
  const control = controlBox!;
  const overlaps = !(
    hint.x + hint.width <= control.x ||
    control.x + control.width <= hint.x ||
    hint.y + hint.height <= control.y ||
    control.y + control.height <= hint.y
  );
  expect(overlaps).toBe(false);
});

test('round11: options page keeps a single column on wide screens', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/tests/browser/options-regression.html');
  await page.locator('.ot-form').waitFor();

  const metrics = await page.evaluate(() => {
    const form = document.querySelector('.ot-form') as HTMLElement;
    const sections = Array.from(document.querySelectorAll('.ot-form-section')) as HTMLElement[];
    return {
      display: getComputedStyle(form).display,
      leftEdges: [...new Set(sections.map((s) => Math.round(s.getBoundingClientRect().x)))],
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  expect(metrics.display).toBe('block');
  expect(metrics.leftEdges).toHaveLength(1); // 所有分组左边缘一致（旧版是两栏两个 x）
  expect(metrics.overflowX).toBe(0);
});

// ===== round12：免 Key 体验通道 + API Key 填写体验 =====
test('round12: provider dropdown separates keyless trial engines from BYOK engines', async ({
  page,
}) => {
  await page.goto('/tests/browser/selection-regression.html');
  const full = await openFullSettings(page);

  const select = full.locator('select[data-f="provider"]');
  const groups = select.locator('optgroup');
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toHaveAttribute(
    'label',
    /免 Key 体验（零配置，装完就能用）/,
  );
  await expect(groups.nth(1)).toHaveAttribute('label', /接自己的 API（更准更快）/);

  // 免 Key 组：MyMemory / Apertium / Ollama 本地；已下线的 Google 不在列表里
  await expect(groups.nth(0)).toContainText('MyMemory');
  await expect(groups.nth(0)).toContainText('Apertium');
  await expect(groups.nth(0)).toContainText('Ollama');
  await expect(select.locator('option[value="google"]')).toHaveCount(0);

  // 需 Key 组：标注当前是否已配 Key（下拉里就能看出该去填哪一家）
  await expect(groups.nth(1)).toContainText('DeepSeek');
  await expect(groups.nth(1)).toContainText('OpenAI');
  await expect(select.locator('option[value="deepseek"]')).toContainText('（已配 Key）');
  await expect(select.locator('option[value="openai"]')).toContainText('（未配 Key）');
});

test('round12: API key input can be revealed and clears the guide once filled', async ({
  page,
}) => {
  await page.goto('/tests/browser/selection-regression.html');
  const full = await openFullSettings(page);

  // 切到需要 Key 的引擎 → 引导条出现
  const select = full.locator('select[data-f="provider"]');
  await select.selectOption('openai');
  const guide = full.locator('[data-f="keyGuide"]');
  await expect(guide).toBeVisible();
  await expect(guide).toContainText('免 Key 体验');

  // 掩码输入可以切成明文核对（点完按钮文案变成「隐藏」）
  const keyInput = full.locator('input[data-f="apiKey"]');
  const toggle = full.locator('[data-f="keyToggle"]');
  await expect(keyInput).toHaveAttribute('type', 'password');
  await toggle.click();
  await expect(keyInput).toHaveAttribute('type', 'text');
  await expect(toggle).toHaveText('隐藏');

  // 填入 Key 后引导条立即消失、下拉标注变成「已配 Key」
  await keyInput.fill('sk-round12-test-key');
  await expect(guide).toBeHidden();
  await expect(select.locator('option[value="openai"]')).toContainText('（已配 Key）');
});

// ===== round13：布局安全（Apple 官网按钮被撑成正圆的回归） =====
test('round13: standalone link buttons are never translated inside', async ({ page }) => {
  await page.goto('/tests/browser/layout-regression.html');
  const toolbar = page.locator('#ot-toolbar');
  await expect(toolbar).toBeVisible();
  await toolbar.click();
  await expect(toolbar).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });

  const cta = page.locator('.tile-ctas');
  // 容器与按钮内部都不应出现任何译文节点
  await expect(cta.locator('.ot-translation')).toHaveCount(0);

  // 按钮保持原子形状：文本不变、没有被译文撑高（撑坏后会接近正圆）
  const learn = cta.locator('a.button', { hasText: 'Learn more' });
  await expect(learn).toHaveText('Learn more');
  const box = await learn.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeLessThan(60);

  // 跳过按钮不能误伤同一区块的正文：h2 与 p 各有一条译文（afterend 插在原文后面），
  // 且译文中不能混入按钮文字（Learn more / Buy 不进翻译管线）
  const tile = page.locator('.apple-tile');
  await expect(tile.locator(':scope > .ot-translation')).toHaveCount(2);
  const texts = await tile
    .locator(':scope > .ot-translation')
    .evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLElement).dataset.translation || ''),
    );
  expect(texts.some((t) => t.includes('Product headline'))).toBe(true);
  expect(texts.some((t) => t.includes('Learn more'))).toBe(false);
  expect(texts.some((t) => t.includes('Buy'))).toBe(false);
});

test('round13: horizontal flex containers get their translation outside', async ({ page }) => {
  await page.goto('/tests/browser/layout-regression.html');
  const toolbar = page.locator('#ot-toolbar');
  await expect(toolbar).toBeVisible();
  await toolbar.click();
  await expect(toolbar).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });

  // 行向 flex 容器：译文必须插在容器外面（兄弟位置），不能成为新的 flex item
  const row = page.locator('.flex-text-row');
  await expect(row.locator('.ot-translation')).toHaveCount(0);
  const outside = row.locator('xpath=following-sibling::*[1]');
  await expect(outside).toHaveClass(/ot-translation/);

  // 容器自身的子项数量不变（没有被塞进任何东西）
  const childCount = await row.evaluate((element) => element.children.length);
  expect(childCount).toBe(2);
});

// ===== round14：覆盖面与大面板信息完整度 =====
test('round14: page-level nav is left untouched (no half-translated navbar)', async ({ page }) => {
  await page.goto('/tests/browser/layout-regression.html');
  const toolbar = page.locator('#ot-toolbar');
  await expect(toolbar).toBeVisible();
  await toolbar.click();
  await expect(toolbar).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });

  // 页面级导航整条不翻：Apple globalnav 实测半中半英（Store 被翻成商店，
  // MacBook Air 没翻）的根因就是 li 是语义块、逐项收集
  const nav = page.locator('nav.site-nav');
  await expect(nav.locator('.ot-translation')).toHaveCount(0);
  // 原文原样保留
  await expect(nav.locator('li').first()).toHaveText('Store');
  await expect(nav.locator('li').nth(1)).toHaveText('MacBook Air');
});

test('round14: every feature switch explains what it does', async ({ page }) => {
  await page.goto('/tests/browser/selection-regression.html');
  const full = await openFullSettings(page);

  // 功能开关区（.ot-switches）里的每个开关都必须带一句说明——
  // 光秃秃的「流式输出」「上下文感知」用户根本看不懂
  const switches = full.locator('.ot-form-section', { hasText: '功能开关' }).locator('.ot-check');
  const count = await switches.count();
  expect(count).toBeGreaterThanOrEqual(9);
  for (let i = 0; i < count; i++) {
    await expect(switches.nth(i).locator('small')).not.toHaveText('');
  }
});

test('round11: settings panel offers sticky section navigation', async ({ page }) => {
  await page.goto('/tests/browser/selection-regression.html');
  const full = await openFullSettings(page);

  const nav = full.locator('.ot-settings-nav');
  await expect(nav).toBeVisible();
  const items = nav.locator('.ot-settings-nav-item');
  // 分组标题直接取自表单，共七个（含仅页内面板才有的「本站设置」）
  await expect(items).toHaveCount(7);
  await expect(items.first()).toHaveText('翻译引擎');
  await expect(items.last()).toHaveText('高级设置');

  // 吸顶：内容滚动后导航仍贴在滚动区顶部
  const body = full.locator('.ot-full-settings-body');
  await body.evaluate((element) => {
    (element as HTMLElement).scrollTop = 1200;
  });
  const [navTop, bodyTop] = await Promise.all([
    nav.evaluate((element) => element.getBoundingClientRect().top),
    body.evaluate((element) => element.getBoundingClientRect().top),
  ]);
  expect(Math.abs(navTop - bodyTop)).toBeLessThan(8);

  // 点最后一个分组 → 滚到面板末尾（高级设置）
  await items.last().click();
  await expect
    .poll(async () =>
      body.evaluate((element) => (element as HTMLElement).scrollTop),
    )
    .toBeGreaterThan(1200);
});
