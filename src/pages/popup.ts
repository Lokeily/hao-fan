import { browser } from 'wxt/browser';
import { buildConfigForm } from '../../utils/ui';
import { configItem } from '../../utils/storage';
import { getProvider } from '../../utils/providers';
import { getProviderApiKey, normalizeConfig } from '../../utils/config';
import { EMPTY_USAGE_TOTALS, type UsageTotals } from '../../utils/usage';
import '../../styles/options.css';

if (typeof document !== 'undefined' && typeof location !== 'undefined') {
  document.body.innerHTML = `
    <div class="ot-popup">
      <header class="ot-popup-head">
        <span class="ot-brand-mark" aria-hidden="true">好</span>
        <div class="ot-brand-copy">
          <strong>好翻</strong>
          <span>开源 AI 翻译</span>
        </div>
      </header>

      <div class="ot-tabs" role="tablist" aria-label="功能切换">
        <button type="button" class="ot-tab active" role="tab" aria-selected="true" data-tab="translate">翻译</button>
        <button type="button" class="ot-tab" role="tab" aria-selected="false" data-tab="settings">设置</button>
      </div>

      <div class="ot-panel" id="panel-translate" role="tabpanel">
        <label class="ot-section-label" for="ot-input">文本翻译</label>
        <textarea id="ot-input" rows="4" placeholder="输入或粘贴文本"></textarea>
        <div class="ot-row">
          <button type="button" id="ot-go" class="ot-btn-primary">翻译文本</button>
          <button type="button" id="ot-page" class="ot-btn-secondary" title="翻译当前网页">翻译网页</button>
        </div>
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
          <label class="ot-file" for="ot-file">选择图片
            <input id="ot-file" type="file" accept="image/*" hidden />
          </label>
          <span class="ot-img-caption">图片翻译</span>
          <span id="ot-img-status" class="ot-img-status" role="status" aria-live="polite"></span>
        </div>
      </div>

      <div class="ot-panel hidden" id="panel-settings" role="tabpanel">
        <div id="ot-form-mount"></div>
      </div>
    </div>
  `;

  buildConfigForm(document.getElementById('ot-form-mount') as HTMLElement, true);

  // 标签页切换
  const tabs = Array.from(document.querySelectorAll('.ot-tab')) as HTMLButtonElement[];
  tabs.forEach((t) => {
    t.addEventListener('click', () => {
      tabs.forEach((x) => {
        const active = x === t;
        x.classList.toggle('active', active);
        x.setAttribute('aria-selected', String(active));
      });
      const which = t.dataset.tab;
      document.getElementById('panel-translate')!.classList.toggle('hidden', which !== 'translate');
      document.getElementById('panel-settings')!.classList.toggle('hidden', which !== 'settings');
    });
  });

  const input = document.getElementById('ot-input') as HTMLTextAreaElement;
  const out = document.getElementById('ot-out') as HTMLElement;
  const fileInput = document.getElementById('ot-file') as HTMLInputElement;
  const imgStatus = document.getElementById('ot-img-status') as HTMLElement;
  const translateButton = document.getElementById('ot-go') as HTMLButtonElement;
  const pageButton = document.getElementById('ot-page') as HTMLButtonElement;
  const numberFormat = new Intl.NumberFormat('zh-CN');

  function setButtonBusy(button: HTMLButtonElement, busy: boolean, busyLabel: string) {
    if (!button.dataset.label) button.dataset.label = button.textContent || '';
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
    button.textContent = busy ? busyLabel : button.dataset.label;
  }

  function renderUsage(stats: UsageTotals) {
    document.getElementById('ot-saved')!.textContent = numberFormat.format(stats.estimatedTokensSaved);
    document.getElementById('ot-used')!.textContent = numberFormat.format(stats.promptTokens + stats.completionTokens);
    document.getElementById('ot-local')!.textContent = numberFormat.format(stats.localSkipped);
    document.getElementById('ot-hits')!.textContent = `${numberFormat.format(stats.cacheHits)} / ${numberFormat.format(stats.glossaryHits)}`;
    document.getElementById('ot-stats-detail')!.textContent = stats.translations
      ? `累计 ${numberFormat.format(stats.inputSegments)} 段 · 少发送约 ${numberFormat.format(stats.estimatedTokensSaved)} Token · ${numberFormat.format(stats.requests)} 次请求`
      : '尚无翻译记录';
  }

  async function loadUsage() {
    try {
      const response = await browser.runtime.sendMessage({ type: 'GET_USAGE_STATS' }) as
        { ok?: boolean; stats?: UsageTotals } | undefined;
      renderUsage(response?.ok && response.stats ? response.stats : EMPTY_USAGE_TOTALS);
    } catch {
      renderUsage(EMPTY_USAGE_TOTALS);
    }
  }

  document.getElementById('ot-stats-reset')!.addEventListener('click', async () => {
    try {
      const response = await browser.runtime.sendMessage({ type: 'RESET_USAGE_STATS' }) as
        { ok?: boolean; stats?: UsageTotals } | undefined;
      if (response?.ok) renderUsage(response.stats || EMPTY_USAGE_TOTALS);
    } catch {
      // 后台暂不可用时保留现有统计，避免弹窗产生未处理异常。
    }
  });
  loadUsage();

  translateButton.addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text) return;
    setButtonBusy(translateButton, true, '翻译中…');
    out.textContent = '翻译中…';
    try {
      const cfg = normalizeConfig(await configItem.getValue());
      if (!getProviderApiKey(cfg) && getProvider(cfg.provider)?.needsKey) {
        out.textContent = '请先在「设置」页填写 API Key';
        return;
      }
      const res = await browser.runtime.sendMessage({
        type: 'TRANSLATE_ONE',
        payload: { text },
      }) as { ok?: boolean; translation?: string; error?: string } | undefined;
      out.textContent = res?.ok ? res.translation || '' : res?.error || '翻译失败';
      if (res?.ok) await loadUsage();
    } catch (error) {
      out.textContent = error instanceof Error ? error.message : '翻译失败';
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
    out.textContent = '正在翻译当前网页…';
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        out.textContent = '未找到当前标签页';
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
      out.textContent = '已发送翻译指令，右下角「译」按钮也会出现；译文将插在原文下方。';
    } catch (e: any) {
      out.textContent =
        '无法翻译此页面：' + (e?.message || '不支持的页面') +
        '\n（PDF / 浏览器内部页不支持内嵌翻译，可复制文字用上方框翻译，或对截图用「上传图片翻译」）';
    } finally {
      setButtonBusy(pageButton, false, '发送中…');
    }
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) {
      imgStatus.textContent = '图片不能超过 6 MB';
      fileInput.value = '';
      return;
    }
    const cfg = normalizeConfig(await configItem.getValue());
    const prov = getProvider(cfg.provider);
    const supportsVision = prov?.vision || (prov?.id === 'custom' && cfg.customVision);
    if (!supportsVision) {
      imgStatus.textContent = '当前引擎不支持图片，请选视觉模型（如 GPT-4o/Gemini/GLM-4V/千问 VL）';
      return;
    }
    if (!getProviderApiKey(cfg) && prov?.needsKey) {
      imgStatus.textContent = '请先在「设置」页填写 API Key';
      return;
    }
    imgStatus.textContent = '图片翻译中…（将打开新标签页）';
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => typeof r.result === 'string' ? resolve(r.result) : reject(new Error('读取图片失败'));
        r.onerror = () => reject(new Error('读取图片失败'));
        r.readAsDataURL(file);
      });
      const res = await browser.runtime.sendMessage({
        type: 'TRANSLATE_IMAGE',
        payload: { dataUrl },
      }) as { ok?: boolean; error?: string } | undefined;
      imgStatus.textContent = res?.ok ? '已打开结果页 ✓' : res?.error || '图片翻译失败';
    } catch (error) {
      imgStatus.textContent = error instanceof Error ? error.message : '图片翻译失败';
    } finally {
      fileInput.value = '';
    }
  });
}
