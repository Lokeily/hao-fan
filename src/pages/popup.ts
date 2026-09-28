import { browser } from 'wxt/browser';
import { buildConfigForm } from '../../utils/ui.ts';
import { configItem, disabledSitesItem, onboardingDoneItem } from '../../utils/storage.ts';
import { getProvider } from '../../utils/providers.ts';
import { getProviderApiKey, normalizeConfig } from '../../utils/config.ts';
import { isSiteDisabled, siteKeyOf, withSiteDisabled } from '../../utils/site-policy.ts';
import { EMPTY_USAGE_TOTALS, type UsageTotals } from '../../utils/usage.ts';
import { MAX_TEXT_CHARS } from '../../utils/messages.ts';
import {
  addHistoryEntry,
  clearHistory,
  getHistory,
  type HistoryEntry,
} from '../../utils/history-store.ts';
import '../../styles/options.css';

if (typeof document !== 'undefined' && typeof location !== 'undefined') {
  // 防御性基础样式：即使外部 CSS 加载失败，弹窗也保持可读（背景/字体/宽度）。
  // 颜色跟随系统深浅色（不能写死浅色，否则深色系统下白字浅底看不清）。
  const defensiveDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  document.body.style.setProperty('width', '360px');
  document.body.style.setProperty('margin', '0');
  document.body.style.setProperty('background', defensiveDark ? '#000000' : '#f2f2f7');
  document.body.style.setProperty('color', defensiveDark ? '#f5f5f7' : '#1d1d1f');
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
        <button type="button" id="tab-history" class="ot-tab" role="tab" aria-selected="false" aria-controls="panel-history" tabindex="-1" data-tab="history">历史</button>
        <button type="button" id="tab-settings" class="ot-tab" role="tab" aria-selected="false" aria-controls="panel-settings" tabindex="-1" data-tab="settings">设置</button>
      </div>

      <div class="ot-panel hidden" id="panel-history" role="tabpanel" aria-labelledby="tab-history">
        <div class="ot-history-toolbar">
          <input id="ot-history-search" type="search" placeholder="搜索原文或译文…" aria-label="搜索翻译历史" />
          <button id="ot-history-clear" type="button" title="清空全部历史">清空</button>
        </div>
        <div id="ot-history-list" class="ot-history-list" role="list"></div>
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
          <div id="ot-budget" class="ot-budget" hidden>
            <div class="ot-budget-head">
              <span>本月 Token 预算</span>
              <span id="ot-budget-text">—</span>
            </div>
            <div class="ot-budget-track" aria-hidden="true">
              <div id="ot-budget-bar" class="ot-budget-bar" style="width: 0%"></div>
            </div>
            <div class="ot-budget-row">
              <input id="ot-budget-input" type="number" min="0" step="1000" placeholder="0 = 不限" aria-label="月度 Token 预算" />
              <button id="ot-budget-save" type="button">保存</button>
            </div>
            <p class="ot-budget-hint">按自然月累计实际消耗，跨月自动归零。设置后用到 <span id="ot-budget-warn">80</span>% 会变红提醒。</p>
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

      <div id="ot-welcome" class="ot-welcome" role="dialog" aria-modal="true" aria-labelledby="ot-welcome-title" hidden>
        <div class="ot-welcome-card">
          <div class="ot-welcome-brand" aria-hidden="true">
            <img src="${logoUrl}" alt="" />
          </div>
          <h2 id="ot-welcome-title">欢迎使用好翻</h2>
          <p class="ot-welcome-sub">你的网页翻译助手。选一种方式开始：</p>
          <button type="button" id="ot-welcome-free" class="ot-btn-primary ot-welcome-btn">免费体验 · 不填 Key</button>
          <p class="ot-welcome-free-note">用 Google 翻译，零配置、零费用、开箱即用</p>
          <button type="button" id="ot-welcome-config" class="ot-btn-secondary ot-welcome-btn">配置自己的 AI 引擎</button>
          <p class="ot-welcome-config-note">接入 DeepSeek / 智谱 / 混元等，质量更高</p>
          <button type="button" id="ot-welcome-skip" class="ot-welcome-skip">先跳过，我自己逛逛</button>
        </div>
      </div>
    </div>
  `;

  // 表单渲染保护：异常时不至于整页空白，提示可恢复操作
  try {
    buildConfigForm(document.getElementById('ot-form-mount') as HTMLElement, true);
  } catch {
    const mount = document.getElementById('ot-form-mount');
    if (mount) {
      mount.textContent = '设置加载失败，请重新打开弹窗或检查扩展状态';
      mount.style.cssText =
        'padding:12px;font-size:13px;color:#ff3b30;border-radius:10px;background:rgba(255,59,48,0.08);';
    }
  }

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

  // ===== 首启引导（onboarding）=====
  // 面向完全没接触过 API Key 概念的普通用户：从未配过任何 Key 且未引导过时，
  // 弹窗打开即显示欢迎面板，给「免费体验（免 Key）」与「配置 AI 引擎」两条清晰路径。
  // 完成任一路径（或点跳过）后置位，不再打扰；老用户/已配 Key 用户完全不受影响。
  const welcomeEl = document.getElementById('ot-welcome') as HTMLElement | null;
  const welcomeFreeBtn = document.getElementById('ot-welcome-free') as HTMLButtonElement | null;
  const welcomeConfigBtn = document.getElementById('ot-welcome-config') as HTMLButtonElement | null;
  const welcomeSkipBtn = document.getElementById('ot-welcome-skip') as HTMLButtonElement | null;

  function hasAnyConfiguredKey(cfg: ReturnType<typeof normalizeConfig>): boolean {
    return Object.values(cfg.apiKeys).some((k) => typeof k === 'string' && k.trim().length > 0);
  }

  function finishOnboarding() {
    onboardingDoneItem.setValue(true).catch(() => {});
  }

  async function maybeShowWelcome() {
    try {
      if (await onboardingDoneItem.getValue()) return;
      const cfg = normalizeConfig(await configItem.getValue());
      // 已配过 Key（任何引擎）视为老用户，不打扰
      if (hasAnyConfiguredKey(cfg)) {
        finishOnboarding();
        return;
      }
      if (welcomeEl) welcomeEl.hidden = false;
    } catch {
      /* 存储不可用时跳过引导，不影响主流程 */
    }
  }

  welcomeFreeBtn?.addEventListener('click', async () => {
    try {
      // 一键切到 Google 翻译（免 Key、免配置），立即可用
      const latest = normalizeConfig(await configItem.getValue());
      const next = {
        ...latest,
        provider: 'google',
        baseUrl: 'https://translate.googleapis.com',
        model: '',
      };
      await configItem.setValue(next);
      finishOnboarding();
      if (welcomeEl) welcomeEl.hidden = true;
      setOutput('已切换到 Google 翻译（免 Key），现在可以翻译了 🎉', 'success');
      // 设置面板里的表单需要刷新为新引擎
      try {
        const mount = document.getElementById('ot-form-mount');
        if (mount) {
          mount.textContent = '';
          buildConfigForm(mount, true);
        }
      } catch {
        /* 表单刷新失败不影响主流程 */
      }
    } catch {
      setOutput('切换失败，请重试或手动在「设置」里选择引擎', 'error');
    }
  });

  welcomeConfigBtn?.addEventListener('click', () => {
    finishOnboarding();
    if (welcomeEl) welcomeEl.hidden = true;
    activateTab(tabs[2]!); // 跳到设置 tab
  });

  welcomeSkipBtn?.addEventListener('click', () => {
    finishOnboarding();
    if (welcomeEl) welcomeEl.hidden = true;
  });

  void maybeShowWelcome();

  const input = document.getElementById('ot-input') as HTMLTextAreaElement;
  // 打开弹窗自动聚焦输入框，直接输入即可翻译（多数用户场景）
  input?.focus({ preventScroll: true });
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

  // ===== 翻译历史 =====
  // 记录「用户主动发起」的单条翻译（划词 / 输入框 / 弹窗），支持搜索、点击回填、清空。
  const historyList = document.getElementById('ot-history-list') as HTMLElement;
  const historySearch = document.getElementById('ot-history-search') as HTMLInputElement;
  const historyClearBtn = document.getElementById('ot-history-clear') as HTMLButtonElement;
  let historyEntries: HistoryEntry[] = [];

  const SOURCE_LABEL: Record<HistoryEntry['source'], string> = {
    selection: '划词',
    input: '输入框',
    popup: '弹窗',
  };

  function formatHistoryTime(ts: number): string {
    const date = new Date(ts);
    const today = new Date();
    const sameDay =
      date.getFullYear() === today.getFullYear() &&
      date.getMonth() === today.getMonth() &&
      date.getDate() === today.getDate();
    const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    return sameDay ? `今天 ${hm}` : `${date.getMonth() + 1}/${date.getDate()} ${hm}`;
  }

  function renderHistory() {
    const query = historySearch.value.trim().toLowerCase();
    const items = query
      ? historyEntries.filter(
          (e) =>
            e.text.toLowerCase().includes(query) || e.translation.toLowerCase().includes(query),
        )
      : historyEntries;
    historyList.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ot-history-empty';
      empty.textContent = query ? '没有匹配的历史记录' : '还没有翻译记录：划词、输入框或此处翻译的文本会出现在这里';
      historyList.appendChild(empty);
      return;
    }
    for (const entry of items.slice(0, 100)) {
      const item = document.createElement('article');
      item.className = 'ot-history-item';
      item.setAttribute('role', 'listitem');
      item.title = '点击回填到文本翻译';
      const meta = document.createElement('div');
      meta.className = 'ot-history-meta';
      const badge = document.createElement('span');
      badge.className = 'ot-history-badge';
      badge.textContent = SOURCE_LABEL[entry.source] || entry.source;
      const time = document.createElement('time');
      time.textContent = formatHistoryTime(entry.ts);
      meta.append(badge, time);
      const sourceLine = document.createElement('div');
      sourceLine.className = 'ot-history-source';
      sourceLine.textContent = entry.text.length > 120 ? `${entry.text.slice(0, 120)}…` : entry.text;
      const resultLine = document.createElement('div');
      resultLine.className = 'ot-history-translation';
      resultLine.textContent =
        entry.translation.length > 160 ? `${entry.translation.slice(0, 160)}…` : entry.translation;
      item.append(meta, sourceLine, resultLine);
      item.addEventListener('click', () => {
        input.value = entry.text;
        updateInputCount();
        activateTab(tabs[0]!);
        input.focus({ preventScroll: true });
        setOutput('已回填历史记录，可直接修改后翻译。', 'neutral');
      });
      historyList.appendChild(item);
    }
  }

  async function loadHistory() {
    try {
      historyEntries = await getHistory();
    } catch {
      historyEntries = [];
    }
    renderHistory();
  }

  historySearch.addEventListener('input', renderHistory);
  // 清空二次确认：清空不可恢复，误触代价高。第一次点击变「确认清空？」，
  // 3 秒内再点才真正执行；期间点其它区域自动复位。
  let historyClearArmed = false;
  let historyClearArmTimer: ReturnType<typeof setTimeout> | null = null;
  const disarmHistoryClear = () => {
    historyClearArmed = false;
    if (historyClearArmTimer) clearTimeout(historyClearArmTimer);
    historyClearArmTimer = null;
    if (historyClearBtn.isConnected) historyClearBtn.textContent = '清空';
  };
  historyClearBtn.addEventListener('click', async () => {
    if (!historyEntries.length) return;
    if (!historyClearArmed) {
      historyClearArmed = true;
      historyClearBtn.textContent = '确认清空？';
      historyClearArmTimer = setTimeout(disarmHistoryClear, 3000);
      return;
    }
    disarmHistoryClear();
    historyClearBtn.disabled = true;
    try {
      await clearHistory();
      historyEntries = [];
      renderHistory();
    } finally {
      historyClearBtn.disabled = false;
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (historyClearArmed && !(event.target as Element | null)?.closest?.('#ot-history-clear')) {
      disarmHistoryClear();
    }
  });
  // 切到历史标签页时刷新（其它入口可能刚写入了新记录）。
  tabs[1]?.addEventListener('click', () => void loadHistory());
  void loadHistory();

  // 弹窗可能与网页内快速/完整设置同时打开。站点暂停状态也订阅 storage，
  // 任一入口修改后，弹窗开关与“翻译网页”按钮立即反映最新状态。
  try {
    disabledSitesItem.watch((sites) => {
      if (activePageUrl) renderSitePolicy(isSiteDisabled(sites, activePageUrl));
    });
  } catch {
    /* storage 监听不可用时保留当前弹窗状态 */
  }

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

  // ===== 月度预算 =====
  // BYOK 用户自付 API 费：展示「本月已用 / 预算」进度，超阈值变红提醒，防不知不觉烧钱。
  async function loadBudget() {
    try {
      const res = (await browser.runtime.sendMessage({ type: 'GET_BUDGET_STATUS' })) as
        | {
            ok?: boolean;
            budget?: number;
            warnPercent?: number;
            monthUsage?: { yearMonth?: string; usedTokens?: number } | null;
          }
        | undefined;
      const budget = Number(res?.budget) || 0;
      const warnPercent = Number(res?.warnPercent) || 80;
      const used = Math.max(0, Number(res?.monthUsage?.usedTokens) || 0);
      const budgetEl = document.getElementById('ot-budget')!;
      const warnEl = document.getElementById('ot-budget-warn')!;
      warnEl.textContent = String(warnPercent);
      const input = document.getElementById('ot-budget-input') as HTMLInputElement;
      input.value = budget > 0 ? String(budget) : '';
      if (budget <= 0) {
        budgetEl.hidden = true;
        return;
      }
      budgetEl.hidden = false;
      const percent = Math.min(100, Math.round((used / budget) * 100));
      document.getElementById('ot-budget-text')!.textContent =
        `${numberFormat.format(used)} / ${numberFormat.format(budget)}（${percent}%）`;
      const bar = document.getElementById('ot-budget-bar')!;
      bar.style.width = `${percent}%`;
      const over = percent >= warnPercent;
      budgetEl.classList.toggle('ot-budget-over', over);
      bar.classList.toggle('ot-budget-bar-over', over);
    } catch {
      /* 预算读取失败不影响统计面板主体 */
    }
  }

  document.getElementById('ot-budget-save')!.addEventListener('click', async () => {
    const input = document.getElementById('ot-budget-input') as HTMLInputElement;
    const value = Math.max(0, Math.floor(Number(input.value) || 0));
    try {
      const cfg = normalizeConfig(await configItem.getValue());
      await configItem.setValue({ ...cfg, monthlyTokenBudget: value });
      await loadBudget();
    } catch {
      /* 保存失败保持现状 */
    }
  });
  // 预算输入框回车即保存：与「保存」按钮等效，减少一次点击（数字类输入高频场景）。
  document.getElementById('ot-budget-input')!.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    (document.getElementById('ot-budget-save') as HTMLButtonElement)?.click();
  });

  loadBudget();
  loadUsage();

  document.getElementById('ot-stats-reset')!.addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    button.textContent = '清零中…';
    try {
      const response = (await browser.runtime.sendMessage({ type: 'RESET_USAGE_STATS' })) as
        { ok?: boolean; stats?: UsageTotals } | undefined;
      if (response?.ok) {
        renderUsage(response.stats || EMPTY_USAGE_TOTALS);
        await loadBudget();
      } else document.getElementById('ot-stats-detail')!.textContent = '统计清零失败，请重试';
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
      })) as
        | { ok?: boolean; translation?: string; error?: string; localSkipped?: boolean }
        | undefined;
      // 空译文单独提示：静默输出空串会让用户分不清「成功」还是「坏了」。
      // 本地跳过（原文已是目标语言）同样说明，避免「怎么没反应」的困惑。
      const skipNote = res?.localSkipped === true ? '\n（原文已是目标语言，未翻译）' : '';
      setOutput(
        res?.ok
          ? res.translation || '（译文为空：该引擎未返回内容，可尝试换模型或重试）'
          : res?.error || '翻译失败',
        res?.ok ? 'neutral' : 'error',
      );
      if (skipNote) out.appendChild(document.createTextNode(skipNote));
      if (res?.ok && res.translation && res.localSkipped !== true) {
        void addHistoryEntry({ text, translation: res.translation, source: 'popup' });
      }
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
      // 内容脚本会回传真实结果：手动模式 / 已暂停不再是误导性的「已发送」。
      const res = (await browser.tabs.sendMessage(tab.id, {
        type: 'TRANSLATE_PAGE',
      })) as { ok?: boolean; reason?: string } | undefined;
      if (res && res.ok === false) {
        if (res.reason === 'manual') {
          setOutput('当前网页是手动模式：在网页中点击段落或划选文字即可翻译。', 'neutral');
        } else {
          setOutput('该网站的翻译已暂停：打开上方开关即可恢复。', 'error');
        }
        return;
      }
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
