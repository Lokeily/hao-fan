import { browser } from 'wxt/browser';
import { buildConfigForm } from '../../utils/ui.ts';
import { configItem, disabledSitesItem } from '../../utils/storage.ts';
import { getProvider } from '../../utils/providers.ts';
import { getProviderApiKey, normalizeConfig } from '../../utils/config.ts';
import { isSiteDisabled, siteKeyOf, withSiteDisabled } from '../../utils/site-policy.ts';
import { EMPTY_USAGE_TOTALS, type UsageTotals } from '../../utils/usage.ts';
import { MAX_TEXT_CHARS } from '../../utils/messages.ts';
import '../../styles/options.css';

if (typeof document !== 'undefined' && typeof location !== 'undefined') {
  // 防御性基础样式：即使外部 CSS 加载失败，弹窗也保持可读（背景/字体/宽度）。
  document.body.style.setProperty('width', '360px');
  document.body.style.setProperty('margin', '0');
  document.body.style.setProperty('background', '#f2f2f7');
  document.body.style.setProperty('color', '#1d1d1f');
  document.body.style.setProperty(
    'font-family',
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif',
  );
  document.body.style.setProperty('color-scheme', 'light dark');
  const logoUrl =
    typeof browser.runtime.getURL === 'function'
      ? browser.runtime.getURL('/icon-128.png')
      : '/public/icon-128.png';
  document.body.innerHTML = `
    <div class="ot-popup">
      <header class="ot-popup-head">
        <span class="ot-brand-mark" aria-hidden="true"><img src="${logoUrl}" alt="" /></span>
        <div class="ot-brand-copy">
          <strong>好翻</strong>
          <span>开源 AI 翻译</span>
        </div>
      </header>

      <div class="ot-tabs" role="tablist" aria-label="功能切换">
        <button type="button" id="tab-translate" class="ot-tab active" role="tab" aria-selected="true" aria-controls="panel-translate" tabindex="0" data-tab="translate">翻译</button>
        <button type="button" id="tab-settings" class="ot-tab" role="tab" aria-selected="false" aria-controls="panel-settings" tabindex="-1" data-tab="settings">设置</button>
      </div>

      <div class="ot-panel" id="panel-translate" role="tabpanel" aria-labelledby="tab-translate">
        <div class="ot-section-head">
          <label class="ot-section-label" for="ot-input">文本翻译</label>
          <span id="ot-input-count" class="ot-input-count">0 / 20,000</span>
        </div>
        <textarea id="ot-input" rows="4" maxlength="${MAX_TEXT_CHARS}" placeholder="输入或粘贴文本"></textarea>
        <div class="ot-row">
          <button type="button" id="ot-go" class="ot-btn-primary">翻译文本</button>
          <button type="button" id="ot-page" class="ot-btn-secondary" title="正在读取当前页面状态" data-policy-disabled="true" disabled>翻译网页</button>
        </div>
        <label class="ot-site-control" id="ot-site-control" hidden>
          <span class="ot-site-copy">
            <strong>当前网站翻译</strong>
            <small><span id="ot-site-host"></span> · <span id="ot-site-state"></span></small>
          </span>
          <input id="ot-site-enabled" type="checkbox" role="switch" aria-label="在当前网站启用翻译" />
          <span class="ot-switch-track" aria-hidden="true"><span></span></span>
        </label>
        <div id="ot-out" class="ot-out" role="status" aria-live="polite"></div>
        <section class="ot-stats" aria-label="Token 使用统计">
          <div class="ot-stats-head">
            <strong>Token 统计</strong>
            <button id="ot-stats-reset" type="button" title="清空累计统计">清零</button>
          </div>
          <div class="ot-stats-grid">
            <div><span id="ot-saved">0</span><small>约省 Token</small></div>
            <div><span id="ot-used">0</span><small>实际 Token</small></div>
            <div><span id="ot-local">0</span><small>本地跳过</small></div>
            <div><span id="ot-hits">0</span><small>缓存 / 术语</small></div>
          </div>
          <div id="ot-stats-detail" class="ot-stats-detail">尚无翻译记录</div>
        </section>
        <div class="ot-img-row">
          <label class="ot-file" for="ot-file">上传图片翻译
            <input id="ot-file" type="file" accept="image/*" hidden />
          </label>
          <span class="ot-img-caption">PNG / JPG · 最大 6 MB</span>
          <span id="ot-img-status" class="ot-img-status" role="status" aria-live="polite"></span>
        </div>
      </div>

      <div class="ot-panel hidden" id="panel-settings" role="tabpanel" aria-labelledby="tab-settings">
        <div id="ot-form-mount"></div>
      </div>
    </div>
  `;

  buildConfigForm(document.getElementById('ot-form-mount') as HTMLElement, true);

  // 标签页切换
  const tabs = Array.from(document.querySelectorAll('.ot-tab')) as HTMLButtonElement[];
  function activateTab(tab: HTMLButtonElement, focus = false) {
    tabs.forEach((candidate) => {
      const active = candidate === tab;
      candidate.classList.toggle('active', active);
      candidate.setAttribute('aria-selected', String(active));
      candidate.tabIndex = active ? 0 : -1;
      const panelId = candidate.getAttribute('aria-controls');
      if (panelId) document.getElementById(panelId)?.classList.toggle('hidden', !active);
    });
    if (focus) tab.focus();
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activateTab(tab));
    tab.addEventListener('keydown', (event) => {
      let nextIndex: number | null = null;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = tabs.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      activateTab(tabs[nextIndex], true);
    });
  });

  const input = document.getElementById('ot-input') as HTMLTextAreaElement;
  const inputCount = document.getElementById('ot-input-count') as HTMLElement;
  const out = document.getElementById('ot-out') as HTMLElement;
  const fileInput = document.getElementById('ot-file') as HTMLInputElement;
  const imgStatus = document.getElementById('ot-img-status') as HTMLElement;
  const translateButton = document.getElementById('ot-go') as HTMLButtonElement;
  const pageButton = document.getElementById('ot-page') as HTMLButtonElement;
  const siteControl = document.getElementById('ot-site-control') as HTMLLabelElement;
  const siteToggle = document.getElementById('ot-site-enabled') as HTMLInputElement;
  const siteHost = document.getElementById('ot-site-host') as HTMLElement;
  const siteState = document.getElementById('ot-site-state') as HTMLElement;
  const numberFormat = new Intl.NumberFormat('zh-CN');
  let activeTabId: number | undefined;
  let activePageUrl = '';

  type OutputTone = 'neutral' | 'busy' | 'success' | 'error';

  function setOutput(message: string, tone: OutputTone = 'neutral') {
    out.textContent = message;
    out.dataset.tone = message ? tone : '';
  }

  function setImageStatus(message: string, error = false) {
    imgStatus.textContent = message;
    imgStatus.classList.toggle('is-error', error);
  }

  function updateInputCount() {
    inputCount.textContent = `${numberFormat.format(input.value.length)} / ${numberFormat.format(MAX_TEXT_CHARS)}`;
  }

  input.addEventListener('input', updateInputCount);

  function setButtonBusy(button: HTMLButtonElement, busy: boolean, busyLabel: string) {
    if (!button.dataset.label) button.dataset.label = button.textContent || '';
    button.disabled = busy || button.dataset.policyDisabled === 'true';
    button.setAttribute('aria-busy', String(busy));
    button.textContent = busy ? busyLabel : button.dataset.label;
  }

  function renderSitePolicy(disabled: boolean) {
    siteToggle.checked = !disabled;
    siteState.textContent = disabled ? '已暂停' : '已启用';
    pageButton.dataset.policyDisabled = String(disabled);
    pageButton.disabled = disabled;
    pageButton.title = disabled ? '当前网站已暂停翻译' : '翻译当前网页';
  }

  async function loadSitePolicy() {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      const key = siteKeyOf(tab?.url || '');
      if (!tab?.id || !key) {
        pageButton.dataset.policyDisabled = 'true';
        pageButton.disabled = true;
        pageButton.title = '此页面不支持内嵌翻译';
        return;
      }
      activeTabId = tab.id;
      activePageUrl = tab.url || '';
      siteHost.textContent = key;
      siteControl.hidden = false;
      renderSitePolicy(isSiteDisabled(await disabledSitesItem.getValue(), activePageUrl));
    } catch {
      siteControl.hidden = true;
      pageButton.dataset.policyDisabled = 'true';
      pageButton.disabled = true;
      pageButton.title = '无法读取当前页面状态';
    }
  }

  siteToggle.addEventListener('change', async () => {
    if (!activePageUrl) return;
    const enabled = siteToggle.checked;
    siteToggle.disabled = true;
    try {
      const sites = await disabledSitesItem.getValue();
      await disabledSitesItem.setValue(withSiteDisabled(sites, activePageUrl, !enabled));
      renderSitePolicy(!enabled);
      if (activeTabId) {
        await browser.tabs
          .sendMessage(activeTabId, {
            type: 'SITE_POLICY_CHANGED',
            payload: { disabled: !enabled },
          })
          .catch(() => {});
      }
      setOutput(
        enabled ? '已恢复当前网站翻译，无需刷新页面。' : '已暂停当前网站翻译，并清理页面上的译文。',
        'success',
      );
    } catch {
      renderSitePolicy(enabled);
      setOutput('网站设置保存失败，请重试', 'error');
    } finally {
      siteToggle.disabled = false;
    }
  });

  void loadSitePolicy();

  function renderUsage(stats: UsageTotals) {
    document.getElementById('ot-saved')!.textContent = numberFormat.format(
      stats.estimatedTokensSaved,
    );
    document.getElementById('ot-used')!.textContent = numberFormat.format(
      stats.promptTokens + stats.completionTokens,
    );
    document.getElementById('ot-local')!.textContent = numberFormat.format(stats.localSkipped);
    document.getElementById('ot-hits')!.textContent =
      `${numberFormat.format(stats.cacheHits)} / ${numberFormat.format(stats.glossaryHits)}`;
    document.getElementById('ot-stats-detail')!.textContent = stats.translations
      ? `累计 ${numberFormat.format(stats.inputSegments)} 段 · 少发送约 ${numberFormat.format(stats.estimatedTokensSaved)} Token · ${numberFormat.format(stats.requests)} 次请求`
      : '尚无翻译记录';
  }

  async function loadUsage() {
    try {
      const response = (await browser.runtime.sendMessage({ type: 'GET_USAGE_STATS' })) as
        { ok?: boolean; stats?: UsageTotals } | undefined;
      renderUsage(response?.ok && response.stats ? response.stats : EMPTY_USAGE_TOTALS);
    } catch {
      renderUsage(EMPTY_USAGE_TOTALS);
    }
  }

  document.getElementById('ot-stats-reset')!.addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    button.textContent = '清零中…';
    try {
      const response = (await browser.runtime.sendMessage({ type: 'RESET_USAGE_STATS' })) as
        { ok?: boolean; stats?: UsageTotals } | undefined;
      if (response?.ok) renderUsage(response.stats || EMPTY_USAGE_TOTALS);
      else document.getElementById('ot-stats-detail')!.textContent = '统计清零失败，请重试';
    } catch {
      document.getElementById('ot-stats-detail')!.textContent = '统计清零失败，请重试';
    } finally {
      button.disabled = false;
      button.textContent = '清零';
    }
  });
  loadUsage();

  translateButton.addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text) return;
    setButtonBusy(translateButton, true, '翻译中…');
    setOutput('翻译中…', 'busy');
    try {
      const cfg = normalizeConfig(await configItem.getValue());
      if (!getProviderApiKey(cfg) && getProvider(cfg.provider)?.needsKey) {
        setOutput('请先在「设置」页填写 API Key', 'error');
        return;
      }
      const res = (await browser.runtime.sendMessage({
        type: 'TRANSLATE_ONE',
        payload: { text },
      })) as { ok?: boolean; translation?: string; error?: string } | undefined;
      setOutput(
        res?.ok ? res.translation || '' : res?.error || '翻译失败',
        res?.ok ? 'neutral' : 'error',
      );
      if (res?.ok) await loadUsage();
    } catch (error) {
      setOutput(error instanceof Error ? error.message : '翻译失败', 'error');
    } finally {
      setButtonBusy(translateButton, false, '翻译中…');
    }
  });

  input.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      translateButton.click();
    }
  });

  // 翻译当前网页：先按需注入内容脚本（应对未刷新页签），悬浮按钮会同时出现；PDF / 内部页会明确报错
  pageButton.addEventListener('click', async () => {
    setButtonBusy(pageButton, true, '发送中…');
    setOutput('正在翻译当前网页…', 'busy');
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setOutput('未找到当前标签页', 'error');
        return;
      }
      try {
        await browser.scripting?.executeScript({
          target: { tabId: tab.id },
          files: ['/content-scripts/content.js'],
        });
      } catch {
        /* 受限页面注入会失败，下面 sendMessage 会给出明确提示 */
      }
      await browser.tabs.sendMessage(tab.id, { type: 'TRANSLATE_PAGE' });
      setOutput('已发送翻译指令，译文将显示在原文下方。', 'success');
    } catch (e: any) {
      setOutput(
        '无法翻译此页面：' +
          (e?.message || '不支持的页面') +
          '\nPDF 或浏览器内部页可改用文本翻译或图片翻译。',
        'error',
      );
    } finally {
      setButtonBusy(pageButton, false, '发送中…');
    }
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) {
      setImageStatus('图片不能超过 6 MB', true);
      fileInput.value = '';
      return;
    }
    fileInput.disabled = true;
    try {
      const cfg = normalizeConfig(await configItem.getValue());
      const prov = getProvider(cfg.provider);
      const supportsVision = prov?.vision || (prov?.id === 'custom' && cfg.customVision);
      if (!supportsVision) {
        setImageStatus('当前引擎不支持图片，请在设置中选择视觉模型', true);
        return;
      }
      if (!getProviderApiKey(cfg) && prov?.needsKey) {
        setImageStatus('请先在「设置」页填写 API Key', true);
        return;
      }
      setImageStatus('图片翻译中…');
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () =>
          typeof r.result === 'string' ? resolve(r.result) : reject(new Error('读取图片失败'));
        r.onerror = () => reject(new Error('读取图片失败'));
        r.readAsDataURL(file);
      });
      const res = (await browser.runtime.sendMessage({
        type: 'TRANSLATE_IMAGE',
        payload: { dataUrl },
      })) as { ok?: boolean; error?: string } | undefined;
      setImageStatus(res?.ok ? '已打开图片翻译结果' : res?.error || '图片翻译失败', !res?.ok);
    } catch (error) {
      setImageStatus(error instanceof Error ? error.message : '图片翻译失败', true);
    } finally {
      fileInput.value = '';
      fileInput.disabled = false;
    }
  });
}
