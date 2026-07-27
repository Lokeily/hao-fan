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

test('batch mismatch falls back with bounded concurrency and translates revealed content', async ({ page }) => {
  await page.goto('/tests/browser/selection-regression.html');
  const toolbar = page.locator('#ot-toolbar');
  await expect(toolbar).toBeVisible();
  await toolbar.click();
  await expect(toolbar).toHaveAttribute('aria-busy', 'false');

  const root = page.locator('html');
  await expect.poll(async () => Number(await root.getAttribute('data-single-requests'))).toBeGreaterThan(0);
  expect(Number(await root.getAttribute('data-max-active-singles'))).toBeLessThanOrEqual(2);

  const callsBeforeReveal = Number(await root.getAttribute('data-translation-calls'));
  await page.getByRole('button', { name: 'Toggle panel' }).click();
  await expect(page.locator('#controlled-panel .ot-translation')).toBeVisible();
  await expect.poll(async () => Number(await root.getAttribute('data-translation-calls')))
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
  await expect.poll(async () => {
    const value = await page.locator('html').getAttribute('data-requested-texts');
    return JSON.parse(value || '[]').some((text: string) => text.includes('New content loaded'));
  }).toBe(true);
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
  await expect.poll(async () => Number(await page.locator('html').getAttribute('data-single-requests')))
    .toBe(1);
  await selectionUi.getByRole('button', { name: '关闭划词翻译' }).click();
  await expect.poll(async () => Number(await page.locator('html').getAttribute('data-cancel-requests')))
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

test('the popup resets a rejected image so the same file can be selected again', async ({ page }) => {
  await page.goto('/tests/browser/popup-regression.html');
  const input = page.locator('#ot-file');
  const status = page.locator('#ot-img-status');

  await input.setInputFiles('public/icon-16.png');
  await expect(status).toContainText('当前引擎不支持图片');
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue('');

  await status.evaluate((element) => { element.textContent = '等待重试'; });
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
  await expect.poll(async () => logo.evaluate((image) => (image as HTMLImageElement).naturalWidth))
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

test('image result page explains missing tasks instead of leaving a blank page', async ({ page }) => {
  await page.goto('/tests/browser/image-regression.html');
  await expect(page.getByRole('heading', { name: '缺少图片翻译任务' })).toBeVisible();
});
