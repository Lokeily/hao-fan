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
  await translateTab.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '设置' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: '设置' }).press('ArrowLeft');
  await expect(translateTab).toHaveAttribute('aria-selected', 'true');

  await page.locator('#ot-input').fill('hello');
  await expect(page.locator('#ot-input-count')).toHaveText('5 / 20,000');
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
  await expect(panel).toContainText('快速设置');

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

  // 三列 6 段：每段译文紧跟原文（多列内 appendChild），总数 = h1 + 6 + 4卡 + 4行 = 15
  await expect(page.locator('.ot-translation')).toHaveCount(15);
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
  await expect(full.locator('h2', { hasText: '模型服务' })).toBeVisible();
  await expect(full.locator('h2', { hasText: '翻译偏好' })).toBeVisible();
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
  // 预置"自动翻译此站"偏好后刷新
  await page.evaluate(async () => {
    await (window as any).chrome.storage.local.set({
      autoSites: [location.host],
      config: undefined,
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

test('settings panel follows dark color scheme with readable text', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/tests/browser/selection-regression.html');
  await page.locator('#ot-settings-btn').click();
  const panel = page.locator('#ot-settings-panel');
  await expect(panel).toBeVisible();
  const bg = await panel.evaluate((el) => getComputedStyle(el).backgroundColor);
  // 深色系统：面板为不透明深色底（可读，不透明）
  expect(bg).toMatch(/rgb\(2[0-9],\s*2[0-9],\s*3[0-9]\)|rgb\(28,\s*28,\s*30\)/);
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

  // 输入可用：术语表输入保存
  await full.locator('textarea[data-f="customGlossary"]').fill('TestTerm=测试词');
  await page.waitForTimeout(500);
  const cfgIn = await page.evaluate(
    async () => (await (window as any).chrome.storage.local.get('config')).config,
  );
  expect(cfgIn.customGlossary).toContain('TestTerm=测试词');

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

  await page.keyboard.press('Escape');
  await expect(full).toBeHidden();
  await page.locator('#ot-settings-btn').click();
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
