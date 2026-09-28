import { configItem } from './storage.ts';
import { getCacheStats, clearTranslateCache } from './cache.ts';
import { langTagOf, listVoicesForLang, onVoicesReady } from './speech.ts';
import { sanitizeImportedConfig } from './settings-backup.ts';
import { PROVIDERS } from './providers.ts';
import { LANGUAGES } from './languages.ts';
import { browser } from 'wxt/browser';
import { getProviderApiKey, normalizeConfig, withProviderApiKey, type AppConfig } from './config.ts';

// Options 页与 Popup 共用的配置表单。compact=true 时不显示提示文案（给 popup 用）。
// siteCtx：页面内完整设置面板的站点级偏好（自动翻译/暂停本站），
// 由调用方提供初始状态与写入回调，并可通过返回的 API 外部同步。
export interface SettingsSiteCtx {
  host: string;
  autoTranslate: boolean;
  paused: boolean;
  always: boolean;
  never: boolean;
  onAuto: (enabled: boolean) => void;
  onPause: (paused: boolean) => void;
  onAlways: (enabled: boolean) => void;
  onNever: (enabled: boolean) => void;
}

export interface ConfigFormApi {
  /**
   * 用最新配置重填表单（值相同则不动控件，避免打断输入）。
   * next 传入最新配置快照（如 storage watch 回调），否则用当前内存值。
   */
  update: (next?: AppConfig) => void;
  /** 外部同步站点开关状态（可只传其一） */
  updateSiteState: (auto?: boolean, paused?: boolean, always?: boolean, never?: boolean) => void;
  /** 销毁表单时停止响应后续 storage 同步，避免页内面板反复打开产生旧监听。 */
  dispose: () => void;
  /** 导入等外部操作覆盖配置后调用：清除未保存的本地脏标记，让表单跟随新值。 */
  resetDirty: (next?: AppConfig) => void;
}

export function buildConfigForm(
  mount: HTMLElement,
  compact: boolean,
  siteCtx?: SettingsSiteCtx,
): ConfigFormApi {
  let cfg: AppConfig = normalizeConfig(configItem.defaultValue);

  const formMarkup = `
    <form class="ot-form" autocomplete="off">

      <!-- 无 Key 引导条：面向普通用户，有 Key 或免 Key 引擎时自动隐藏 -->
      <div data-f="keyGuide" class="ot-key-guide" hidden>
        <strong>此引擎需要 API Key</strong>
        <span>想零配置先用起来？把上面的「翻译引擎」切到「免 Key 体验」分组里的任意引擎（MyMemory / Apertium 欧洲语对 / Ollama 本地），装完就能翻译。想要更准更快，再到服务商官网申请 Key 粘贴到下方。</span>
      </div>

      <!-- ═══ ① 翻译引擎 ═══ -->
      <section class="ot-form-section">
        <h2>翻译引擎</h2>
        <div class="ot-field-grid">
          <label class="ot-field">翻译引擎
            <select data-f="provider"></select>
          </label>
          <label class="ot-field" data-f="modelField">模型
            <select data-f="model"></select>
            <input data-f="modelText" type="text" placeholder="如 gpt-4o" hidden />
          </label>
          <label class="ot-field ot-field-wide ot-field-block">API Key
            <span class="ot-key-input-row">
              <input data-f="apiKey" type="password" autocomplete="new-password" placeholder="粘贴服务商给你的 Key，只存在本地" />
              <button type="button" data-f="keyToggle" class="ot-key-toggle" aria-label="显示 API Key">显示</button>
            </span>
          </label>
          <label class="ot-field ot-field-wide ot-field-block">API Base URL
            <input data-f="baseUrl" type="url" inputmode="url" placeholder="https://..." />
          </label>
          <label class="ot-check ot-field-wide" data-custom-vision hidden>
            <input data-f="customVision" type="checkbox" />
            <span><strong>接口支持图片模型</strong><small>仅为兼容视觉输入的自定义接口开启</small></span>
          </label>
        </div>
        <div class="ot-form-actions">
          <button type="button" data-f="test" class="ot-test-btn">测试连接</button>
          <div class="ot-status" role="status" aria-live="polite"></div>
        </div>
        <div class="ot-field-grid ot-migrate-row">
          <button type="button" data-f="cfgCopy" class="ot-migrate-btn">📋 复制配置（含 Key）</button>
          <button type="button" data-f="cfgPaste" class="ot-migrate-btn">📥 从剪贴板恢复</button>
        </div>
      </section>

      <!-- ═══ ② 语言 ═══ -->
      <section class="ot-form-section">
        <h2>语言</h2>
        <div class="ot-field-grid">
          <label class="ot-field">源语言
            <select data-f="sourceLang"></select>
          </label>
          <label class="ot-field">目标语言
            <select data-f="targetLang"></select>
          </label>
          <label class="ot-field">翻译模式
            <span>手动：点段落或划词才翻；自动：打开网页整页直翻</span>
            <select data-f="translateMode">
              <option value="manual">手动（推荐）</option>
              <option value="auto">自动整页</option>
            </select>
          </label>
          <label class="ot-field">翻译风格
            <select data-f="tone">
              <option value="自然流畅">自然流畅</option>
              <option value="正式书面">正式书面</option>
              <option value="轻松口语">轻松口语</option>
              <option value="简洁精炼">简洁精炼</option>
            </select>
          </label>
        </div>
      </section>

      <!-- ═══ ③ 译文显示 ═══ -->
      <section class="ot-form-section">
        <h2>译文显示</h2>
        <div class="ot-field-grid">
          <label class="ot-field">对照模式
            <span>决定译文和原文怎么摆</span>
            <select data-f="dualMode">
              <option value="below">译文在原文下方</option>
              <option value="translation-only">只显示译文（悬停看原文）</option>
              <option value="hover-original">译文+悬停高亮原文</option>
            </select>
          </label>
          <label class="ot-field">译文样式
            <span>译文与原文的区分方式</span>
            <select data-f="translationStyle">
              <option value="plain">默认</option>
              <option value="dashed">虚线分隔</option>
              <option value="underline">下划线</option>
              <option value="highlight">高亮块</option>
            </select>
          </label>
          <label class="ot-field">译文字号
            <select data-f="translationFontSize">
              <option value="0">跟随原文</option>
              <option value="12">12 px</option>
              <option value="13">13 px</option>
              <option value="14">14 px</option>
              <option value="15">15 px</option>
              <option value="16">16 px</option>
              <option value="17">17 px</option>
              <option value="18">18 px</option>
            </select>
          </label>
          <label class="ot-field">译文行高
            <select data-f="translationLineHeight">
              <option value="0">默认（1.5）</option>
              <option value="1.2">紧凑（1.2）</option>
              <option value="1.4">标准（1.4）</option>
              <option value="1.6">宽松（1.6）</option>
              <option value="1.8">很宽松（1.8）</option>
              <option value="2">2 倍（2.0）</option>
            </select>
          </label>
          <label class="ot-field">译文透明度
            <span>调低一点更容易分清原文和译文</span>
            <select data-f="translationOpacity">
              <option value="0">默认</option>
              <option value="0.5">50%</option>
              <option value="0.62">62%</option>
              <option value="0.75">75%</option>
              <option value="0.85">85%</option>
              <option value="1">100%</option>
            </select>
          </label>
          <label class="ot-field">译文颜色
            <input data-f="translationColor" type="text" list="ot-color-presets" placeholder="跟随原文" />
            <datalist id="ot-color-presets">
              <option value="#1d1d1f"></option>
              <option value="#3a3a3c"></option>
              <option value="#007aff"></option>
              <option value="#e0342c"></option>
              <option value="#34c759"></option>
              <option value="#8e8e93"></option>
            </datalist>
          </label>
        </div>
      </section>

      <!-- ═══ ④ 界面与朗读 ═══ -->
      <section class="ot-form-section">
        <h2>界面与朗读</h2>
        <div class="ot-field-grid">
          <label class="ot-field">界面主题
            <span>弹窗与译文浮层跟随的配色</span>
            <select data-f="themeMode">
              <option value="auto">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>
          <label class="ot-field ot-field-wide">朗读人声
            <span>按译入语列出；自动优先在线高质量语音</span>
            <select data-f="ttsVoiceName"></select>
          </label>
        </div>
      </section>

      ${siteCtx ? `<section class="ot-form-section">
        <h2>本站设置</h2>
        <div class="ot-switches">
          <label class="ot-check" id="ot-full-auto">
            <input type="checkbox" data-site-ctx="auto" ${siteCtx.autoTranslate ? 'checked' : ''} />
            <span><strong>自动翻译此站</strong><small>开启后覆盖全局手动模式</small></span>
          </label>
          <label class="ot-check" id="ot-full-pause">
            <input type="checkbox" data-site-ctx="pause" ${siteCtx.paused ? 'checked' : ''} />
            <span><strong>暂停本站翻译</strong><small>立即停止并清理译文</small></span>
          </label>
          <label class="ot-check" id="ot-full-always">
            <input type="checkbox" data-site-ctx="always" ${siteCtx.always ? 'checked' : ''} />
            <span><strong>始终翻译此站</strong><small>加入白名单，手动模式下也自动翻译</small></span>
          </label>
          <label class="ot-check" id="ot-full-never">
            <input type="checkbox" data-site-ctx="never" ${siteCtx.never ? 'checked' : ''} />
            <span><strong>永不翻译此站</strong><small>加入排除列表，敏感页面优先跳过</small></span>
          </label>
        </div>
      </section>` : ''}

      <!-- ═══ ⑤ 功能开关 ═══ -->
      <section class="ot-form-section">
        <h2>功能开关</h2>
        <div class="ot-switches">
          <label class="ot-check"><input data-f="streaming" type="checkbox" /><span><strong>流式输出</strong><small>译文边生成边显示，不用等整段出来</small></span></label>
          <label class="ot-check"><input data-f="contextAware" type="checkbox" /><span><strong>上下文感知</strong><small>结合整段语境翻译，代词和术语更准</small></span></label>
          <label class="ot-check"><input data-f="qualityCheck" type="checkbox" /><span><strong>质量自检</strong><small>自动核对数字、链接、代码有没有被翻丢</small></span></label>
          <label class="ot-check"><input data-f="sentenceCache" type="checkbox" /><span><strong>句子级缓存</strong><small>相同的句子只翻一次，更省额度</small></span></label>
          <label class="ot-check"><input data-f="cacheEnabled" type="checkbox" /><span><strong>翻译缓存</strong><small>30 天内翻过的内容直接复用</small></span></label>
          <label class="ot-check"><input data-f="glossaryEnabled" type="checkbox" /><span><strong>术语库</strong><small>内置品牌与技术词对照，品牌名不乱翻</small></span></label>
          <label class="ot-check"><input data-f="hoverTranslate" type="checkbox" /><span><strong>悬停翻译</strong><small>鼠标停在段落上就出译文，不用点击</small></span></label>
          <label class="ot-check"><input data-f="inputTranslate" type="checkbox" /><span><strong>输入框翻译</strong><small>在输入框写外文，一键翻成目标语言</small></span></label>
          <label class="ot-check"><input data-f="autoLearnTerms" type="checkbox" /><span><strong>术语自学习</strong><small>你确认过的译文会被记住，越用越合口味</small></span></label>
        </div>
        <div class="ot-field-grid">
          <label class="ot-field ot-field-wide">术语注入上限
            <span>每段最多带入多少条术语，防止提示词过长拖慢翻译</span>
            <select data-f="glossaryTermLimit">
              <option value="0">关闭</option>
              <option value="6">6 条</option>
              <option value="12">12 条（推荐）</option>
              <option value="24">24 条</option>
            </select>
          </label>
        </div>
        <div class="ot-cache-row">
          <span class="ot-cache-info"><b data-f="cacheCount">—</b> 条缓存（30 天 · 上限 2000）</span>
          <button type="button" data-f="cacheClear" class="ot-cache-clear">清空</button>
        </div>
      </section>

      <!-- ═══ ④ 高级设置（默认折叠） ═══ -->
      <details class="ot-form-section ot-advanced-section">
        <summary>高级设置</summary>
        <div class="ot-field-grid">
          <label class="ot-field ot-field-wide">备用引擎（故障转移）
            <span>主引擎限流时按顺序切换，逗号分隔</span>
            <input data-f="fallbackProviders" type="text" placeholder="deepl, openai" />
          </label>
          <label class="ot-field">长文强模型 · 引擎
            <select data-f="strongProvider"><option value="">不启用</option></select>
          </label>
          <label class="ot-field">长文强模型 · 模型
            <input data-f="strongModel" type="text" placeholder="如 gpt-4o" />
          </label>
          <label class="ot-field">长文路由阈值（字符）
            <input data-f="strongThreshold" type="number" min="200" step="100" />
          </label>
          <label class="ot-field ot-field-wide ot-field-block">系统提示词
            <textarea data-f="systemPrompt" rows="3" placeholder="留空使用内置提示词"></textarea>
          </label>
          <label class="ot-field ot-field-wide ot-field-block">我的术语表 <span>每行：源词=译文</span>
            <textarea data-f="customGlossary" rows="3" placeholder="GitHub=GitHub\nrepository=代码仓库"></textarea>
          </label>
        </div>
      </details>
    </form>
  `;
  const parsedForm = new DOMParser().parseFromString(formMarkup, 'text/html');
  mount.replaceChildren(...Array.from(parsedForm.body.childNodes));

  const form = mount.querySelector('.ot-form') as HTMLFormElement;
  const providerSel = mount.querySelector('[data-f=provider]') as HTMLSelectElement;
  const modelSel = mount.querySelector('[data-f=model]') as HTMLSelectElement;
  const modelText = mount.querySelector('[data-f=modelText]') as HTMLInputElement;
  const modelField = mount.querySelector('[data-f=modelField]') as HTMLElement;
  const baseInput = mount.querySelector('[data-f=baseUrl]') as HTMLInputElement;
  const keyInput = mount.querySelector('[data-f=apiKey]') as HTMLInputElement;
  const keyToggle = mount.querySelector('[data-f=keyToggle]') as HTMLButtonElement | null;
  const sourceSel = mount.querySelector('[data-f=sourceLang]') as HTMLSelectElement;
  const targetSel = mount.querySelector('[data-f=targetLang]') as HTMLSelectElement;
  const toneSel = mount.querySelector('[data-f=tone]') as HTMLSelectElement;
  const translateModeSel = mount.querySelector('[data-f=translateMode]') as HTMLSelectElement;
  const promptInput = mount.querySelector('[data-f=systemPrompt]') as HTMLTextAreaElement;
  const cacheChk = mount.querySelector('[data-f=cacheEnabled]') as HTMLInputElement;
  const glossaryChk = mount.querySelector('[data-f=glossaryEnabled]') as HTMLInputElement;
  const glossaryInput = mount.querySelector('[data-f=customGlossary]') as HTMLTextAreaElement;
  const customVisionChk = mount.querySelector('[data-f=customVision]') as HTMLInputElement;
  const customVisionRow = mount.querySelector('[data-custom-vision]') as HTMLElement;
  const streamingChk = mount.querySelector('[data-f=streaming]') as HTMLInputElement;
  const contextChk = mount.querySelector('[data-f=contextAware]') as HTMLInputElement;
  const qualityChk = mount.querySelector('[data-f=qualityCheck]') as HTMLInputElement;
  const autoLearnChk = mount.querySelector('[data-f=autoLearnTerms]') as HTMLInputElement;
  const sentenceChk = mount.querySelector('[data-f=sentenceCache]') as HTMLInputElement;
  const glossaryTermLimitSel = mount.querySelector('[data-f=glossaryTermLimit]') as HTMLSelectElement;
  const hoverTranslateChk = mount.querySelector('[data-f=hoverTranslate]') as HTMLInputElement;
  const inputTranslateChk = mount.querySelector('[data-f=inputTranslate]') as HTMLInputElement;
  const translationStyleSel = mount.querySelector('[data-f=translationStyle]') as HTMLSelectElement;
  const dualModeSel = mount.querySelector('[data-f=dualMode]') as HTMLSelectElement;
  const translationFontSizeSel = mount.querySelector('[data-f=translationFontSize]') as HTMLSelectElement;
  const translationLineHeightSel = mount.querySelector('[data-f=translationLineHeight]') as HTMLSelectElement;
  const translationOpacitySel = mount.querySelector('[data-f=translationOpacity]') as HTMLSelectElement;
  const translationColorInput = mount.querySelector('[data-f=translationColor]') as HTMLInputElement;
  const themeModeSel = mount.querySelector('[data-f=themeMode]') as HTMLSelectElement;
  const ttsVoiceSel = mount.querySelector('[data-f=ttsVoiceName]') as HTMLSelectElement;
  const fallbackInput = mount.querySelector('[data-f=fallbackProviders]') as HTMLInputElement;
  const strongProviderSel = mount.querySelector('[data-f=strongProvider]') as HTMLSelectElement;
  const strongModelInput = mount.querySelector('[data-f=strongModel]') as HTMLInputElement;
  const strongThresholdInput = mount.querySelector('[data-f=strongThreshold]') as HTMLInputElement;
  const testBtn = mount.querySelector('[data-f=test]') as HTMLButtonElement;
  const status = mount.querySelector('.ot-status') as HTMLElement;
  const cacheCountEl = mount.querySelector('[data-f=cacheCount]') as HTMLElement;
  const cacheClearBtn = mount.querySelector('[data-f=cacheClear]') as HTMLButtonElement;
  const cfgCopyBtn = mount.querySelector('[data-f=cfgCopy]') as HTMLButtonElement;
  const cfgPasteBtn = mount.querySelector('[data-f=cfgPaste]') as HTMLButtonElement;
  const customModelValue = '__haofan_custom_model__';
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  let saveQueue: Promise<void> = Promise.resolve();
  let inputSaveTimer: ReturnType<typeof setTimeout> | null = null;
  // 初始配置读取失败时置位：此时 cfg 还是默认值快照，任何编辑触发的保存都会把
  // 默认值覆盖到存储（真实配置静默丢失）。置位后 save() 直接拒绝写入。
  let configLoadFailed = false;
  // 字段级脏跟踪：记录用户在本表单中实际修改过的配置键。
  // save() 以存储中的最新配置为基底、只叠加这些字段——快速面板 / 弹窗 /
  // options 与本表单并发编辑时不再互相覆盖对方刚写入的值（根治全量快照丢字段）。
  const dirtyFields = new Set<string>();
  const markDirty = (...keys: string[]) => {
    keys.forEach((k) => dirtyFields.add(k));
  };
  let disposed = false;

  function setFormLoading(loading: boolean) {
    form.classList.toggle('is-loading', loading);
    form.setAttribute('aria-busy', String(loading));
    Array.from(form.elements).forEach((element) => {
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLButtonElement
      ) {
        element.disabled = loading;
      }
    });
  }

  function setStatus(message: string, error = false, clearAfter = 0) {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = null;
    status.classList.toggle('is-error', error);
    status.textContent = message;
    if (clearAfter > 0) {
      statusTimer = setTimeout(() => {
        status.textContent = '';
        statusTimer = null;
      }, clearAfter);
    }
  }

  // 引擎下拉按「免 Key 体验 / 接自己的 API」分组：新用户第一眼就看到零配置入口，
  // 想更准更快的再往下找自己要接的引擎。免 Key 引擎不再重复标注「免 Key」。
  const keylessGroup = document.createElement('optgroup');
  keylessGroup.label = '免 Key 体验（零配置，装完就能用）';
  const byokGroup = document.createElement('optgroup');
  byokGroup.label = '接自己的 API（更准更快）';
  PROVIDERS.forEach((p) => {
    const o = document.createElement('option');
    o.value = p.id;
    o.dataset.baseName = p.name;
    if (p.needsKey) o.dataset.needsKey = 'true';
    (p.needsKey ? byokGroup : keylessGroup).appendChild(o);
  });
  providerSel.append(keylessGroup, byokGroup);

  // 需 Key 引擎实时标注「已配 Key / 未配 Key」：填没填、填到哪一家，下拉里直接看得到。
  const refreshProviderLabels = () => {
    providerSel.querySelectorAll('option').forEach((option) => {
      const el = option as HTMLOptionElement;
      if (el.dataset.needsKey !== 'true') {
        el.textContent = el.dataset.baseName || el.textContent || '';
        return;
      }
      const hasKey = Boolean(getProviderApiKey(cfg, el.value).trim());
      el.textContent = hasKey
        ? `${el.dataset.baseName}（已配 Key）`
        : `${el.dataset.baseName}（未配 Key）`;
      if (hasKey) delete el.dataset.missingKey;
      else el.dataset.missingKey = 'true';
    });
    const selected = providerSel.options[providerSel.selectedIndex] as HTMLOptionElement | null;
    providerSel.classList.toggle('missing-key', selected?.dataset.missingKey === 'true');
  };
  const refreshSelectTitles = () => {
    providerSel.title = providerSel.options[providerSel.selectedIndex]?.textContent || '';
    modelSel.title = modelSel.options[modelSel.selectedIndex]?.textContent || modelSel.value;
    sourceSel.title = sourceSel.value;
    targetSel.title = targetSel.value;
  };
  // 「长文强模型」路由只能用大模型通道：传统翻译引擎没有模型名可选。
  PROVIDERS.forEach((p) => {
    if (p.type !== 'llm') return;
    const so = document.createElement('option');
    so.value = p.id;
    so.textContent = p.name;
    strongProviderSel.appendChild(so);
  });

  LANGUAGES.forEach((l) => {
    const s = document.createElement('option');
    s.value = l.name;
    s.textContent = l.name;
    sourceSel.appendChild(s);

    const t = document.createElement('option');
    t.value = l.name;
    t.textContent = l.name;
    targetSel.appendChild(t);
  });

  function fillModels(providerId: string) {
    const p = PROVIDERS.find((x) => x.id === providerId);
    modelSel.innerHTML = '';
    const usesModel = p?.type === 'llm';
    const hasModels = usesModel && p.models.length > 0;
    modelField.hidden = !usesModel;
    modelSel.hidden = !hasModels;
    modelText.hidden = !usesModel || hasModels;
    if (hasModels) {
      p!.models.forEach((m) => {
        const o = document.createElement('option');
        o.value = m;
        o.textContent = m;
        modelSel.appendChild(o);
      });
      const custom = document.createElement('option');
      custom.value = customModelValue;
      custom.textContent = '自定义模型…';
      modelSel.appendChild(custom);
    }
    // 切换引擎时填回预设 Base URL；自定义可编辑，其余锁定为文档端点
    baseInput.value = p?.baseUrl || '';
    baseInput.readOnly = providerId !== 'custom';
    customVisionRow.hidden = providerId !== 'custom';
  }

  // 无 Key 引导条：引擎需要 Key 且当前没填时显示。
  // 按下拉里「当前选中」的引擎判断（不是已保存的 cfg.provider）——
  // 用户刚切到需 Key 引擎、还没保存时也要立刻给出指引。
  function syncKeyGuide() {
    const keyGuide = mount.querySelector('[data-f="keyGuide"]') as HTMLElement | null;
    if (!keyGuide) return;
    const selected = providerSel.value || cfg.provider;
    const prov = PROVIDERS.find((x) => x.id === selected);
    const needsKey = Boolean(prov?.needsKey);
    const hasKey = Boolean(keyInput.value.trim() || getProviderApiKey(cfg, selected).trim());
    keyGuide.hidden = !(needsKey && !hasKey);
  }

  // checkbox 勾选样式：不用 :has()（旧浏览器不支持），由 JS 同步 class。
  function syncCheckState() {
    // 在表单容器内查询：页面内完整设置面板渲染在 Shadow DOM 里，
    // document.querySelectorAll 查不到 shadow 内的开关（此前导致大屏开关全白）。
    mount.querySelectorAll('.ot-form .ot-check').forEach((label) => {
      const input = label.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      label.classList.toggle('is-checked', Boolean(input?.checked));
    });
  }

  function fill() {
    // 仅引擎变化时重建模型下拉；开关切换等外部同步不应反复重建（性能/闪烁）。
    // 本表单中未保存的用户修改（dirty 字段）不被外部同步覆盖。
    if (providerSel.value !== cfg.provider && !dirtyFields.has('provider')) {
      providerSel.value = cfg.provider;
      fillModels(cfg.provider);
    }
    const hasModels = !modelSel.hidden;
    const inSelect = hasModels && Array.from(modelSel.options).some((o) => o.value === cfg.model);
    if (!dirtyFields.has('model')) {
      if (inSelect) {
        modelSel.value = cfg.model;
        modelText.hidden = true;
      } else {
        if (hasModels) {
          modelSel.value = customModelValue;
          modelText.hidden = false;
        }
        modelText.value = cfg.model;
      }
    }
    // 值相同则不写回，避免外部同步打断正在输入的控件
    const setIfDiff = (
      key: string,
      el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
      value: string | boolean,
    ) => {
      // 本表单中未保存的用户修改优先于外部同步；保存成功后自动恢复跟随。
      if (dirtyFields.has(key)) return;
      // 正在输入的文本不被覆盖；复选框和下拉框必须立即同步，
      // 否则用户点击后焦点仍在控件上，另一面板的修改会被错误跳过。
      const editingText =
        el.matches(':focus') &&
        (el instanceof HTMLTextAreaElement ||
          (el instanceof HTMLInputElement && ['text', 'password', 'url', 'number'].includes(el.type)));
      if (editingText) return;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') {
        if (el.checked !== Boolean(value)) el.checked = Boolean(value);
      } else if (String(el.value) !== String(value)) {
        el.value = String(value);
      }
    };
    setIfDiff('baseUrl', baseInput, cfg.baseUrl);
    setIfDiff('apiKey', keyInput, getProviderApiKey(cfg));
    setIfDiff('sourceLang', sourceSel, cfg.sourceLang);
    setIfDiff('targetLang', targetSel, cfg.targetLang);
    setIfDiff('tone', toneSel, cfg.tone || '自然流畅');
    setIfDiff('translateMode', translateModeSel, cfg.translateMode || 'manual');
    setIfDiff('systemPrompt', promptInput, cfg.systemPrompt);
    setIfDiff('cacheEnabled', cacheChk, cfg.cacheEnabled);
    setIfDiff('glossaryEnabled', glossaryChk, cfg.glossaryEnabled !== false);
    setIfDiff('customGlossary', glossaryInput, cfg.customGlossary || '');
    setIfDiff('customVision', customVisionChk, cfg.customVision === true);
    setIfDiff('streaming', streamingChk, cfg.streaming !== false);
    setIfDiff('contextAware', contextChk, cfg.contextAware !== false);
    setIfDiff('qualityCheck', qualityChk, cfg.qualityCheck !== false);
    setIfDiff('autoLearnTerms', autoLearnChk, cfg.autoLearnTerms !== false);
    setIfDiff('sentenceCache', sentenceChk, cfg.sentenceCache !== false);
    setIfDiff('glossaryTermLimit', glossaryTermLimitSel, String(cfg.glossaryTermLimit ?? 12));
    setIfDiff('hoverTranslate', hoverTranslateChk, cfg.hoverTranslate !== false);
    setIfDiff('inputTranslate', inputTranslateChk, cfg.inputTranslate !== false);
    setIfDiff('translationStyle', translationStyleSel, cfg.translationStyle || 'plain');
    setIfDiff('dualMode', dualModeSel, cfg.dualMode || 'below');
    setIfDiff('translationFontSize', translationFontSizeSel, String(cfg.translationFontSize ?? 0));
    setIfDiff('translationLineHeight', translationLineHeightSel, String(cfg.translationLineHeight ?? 0));
    setIfDiff('translationOpacity', translationOpacitySel, String(cfg.translationOpacity ?? 0));
    setIfDiff('translationColor', translationColorInput, cfg.translationColor || '');
    setIfDiff('themeMode', themeModeSel, cfg.themeMode || 'auto');
    // 人声下拉按当前目标语言动态填充后再回填所选值
    refreshVoiceOptions();
    setIfDiff('ttsVoiceName', ttsVoiceSel, cfg.ttsVoiceName || '');
    // 高级字段也必须回填：此前只写不读，打开设置页会显示空值，
    // 用户改其它项保存时会把多引擎配置静默清空（数据丢失 bug）。
    setIfDiff('fallbackProviders', fallbackInput, (cfg.fallbackProviders || []).join(', '));
    const strongValue = cfg.strongProvider || '';
    setIfDiff(
      'strongProvider',
      strongProviderSel,
      strongValue && Array.from(strongProviderSel.options).some((o) => o.value === strongValue)
        ? strongValue
        : '',
    );
    setIfDiff('strongModel', strongModelInput, cfg.strongModel || '');
    setIfDiff('strongThreshold', strongThresholdInput, String(cfg.strongThreshold ?? 1200));
    syncKeyGuide();
    syncCheckState();
    refreshProviderLabels();
    refreshSelectTitles();
  }

  function readModelField(): string {
    // 取当前可见的模型字段（P1-2）
    return modelField.hidden
      ? ''
      : !modelSel.hidden && modelSel.value !== customModelValue
        ? modelSel.value
        : modelText.value.trim();
  }

  async function save(): Promise<boolean> {
    if (configLoadFailed) {
      setStatus('读取设置失败：为防止默认值覆盖你的配置，已暂停保存。请刷新页面重试。', true);
      return false;
    }
    // 无本地修改则不写盘：测试连接 / pagehide 等场景直接放行，也避免空转写。
    if (dirtyFields.size === 0) return true;

    // 同步捕获本轮要写的字段；捕获之后的新修改留给下一轮保存。
    const touched = new Set(dirtyFields);
    touched.forEach((k) => dirtyFields.delete(k));

    // 整个「读存储最新值 → 只叠加脏字段 → 写回」都在串行队列内完成：
    // 若只串行化写入、读取在队列外，飞行中的读取会拿到旧基底，
    // 写回时把并发入口刚写入的 Key 等字段覆盖掉（丢字段）。
    const write = saveQueue.catch(() => {}).then(async () => {
      let base = cfg;
      try {
        base = normalizeConfig(await configItem.getValue());
      } catch {
        /* 读取失败退化为当前内存快照 */
      }
      const next: AppConfig = { ...base, apiKeys: { ...base.apiKeys } };

      if (touched.has('provider')) next.provider = providerSel.value;
      // apiKey 必须在 provider 之后处理：切引擎 + 输新 Key 一并保存时，
      // Key 归属到切换后的服务商。
      if (touched.has('apiKey')) {
        const trimmedKey = keyInput.value.trim();
        if (trimmedKey) next.apiKeys[next.provider] = trimmedKey;
        else delete next.apiKeys[next.provider];
      }
      if (touched.has('model')) next.model = readModelField();
      if (touched.has('baseUrl')) next.baseUrl = baseInput.value.trim();
      if (touched.has('sourceLang')) next.sourceLang = sourceSel.value;
      if (touched.has('targetLang')) next.targetLang = targetSel.value;
      if (touched.has('tone')) next.tone = toneSel.value;
      if (touched.has('translateMode')) {
        next.translateMode = translateModeSel.value === 'manual' ? 'manual' : 'auto';
      }
      if (touched.has('systemPrompt')) next.systemPrompt = promptInput.value.trim();
      if (touched.has('cacheEnabled')) next.cacheEnabled = cacheChk.checked;
      if (touched.has('glossaryEnabled')) next.glossaryEnabled = glossaryChk.checked;
      if (touched.has('customGlossary')) next.customGlossary = glossaryInput.value;
      if (touched.has('customVision')) next.customVision = customVisionChk.checked;
      if (touched.has('streaming')) next.streaming = streamingChk.checked;
      if (touched.has('contextAware')) next.contextAware = contextChk.checked;
      if (touched.has('qualityCheck')) next.qualityCheck = qualityChk.checked;
      if (touched.has('autoLearnTerms')) next.autoLearnTerms = autoLearnChk.checked;
      if (touched.has('sentenceCache')) next.sentenceCache = sentenceChk.checked;
      if (touched.has('glossaryTermLimit')) {
        // 「关闭」选项的 value 是 "0"：Number('0') 为 falsy，旧的 `|| 12` 会把用户
        // 明确选择的关闭静默改写成推荐值 12。必须用显式的有限性判断。
        const termLimit = Number(glossaryTermLimitSel.value);
        next.glossaryTermLimit = Number.isFinite(termLimit) && termLimit >= 0 ? termLimit : 12;
      }
      if (touched.has('hoverTranslate')) next.hoverTranslate = hoverTranslateChk.checked;
      if (touched.has('inputTranslate')) next.inputTranslate = inputTranslateChk.checked;
      if (touched.has('translationStyle')) next.translationStyle = translationStyleSel.value;
      if (touched.has('dualMode')) {
        const mode = dualModeSel.value;
        next.dualMode = mode === 'translation-only' || mode === 'hover-original' ? mode : 'below';
      }
      if (touched.has('translationFontSize')) {
        const v = Number(translationFontSizeSel.value);
        next.translationFontSize = Number.isFinite(v) && v >= 0 ? Math.min(48, Math.round(v)) : 0;
      }
      if (touched.has('translationLineHeight')) {
        const v = Number(translationLineHeightSel.value);
        next.translationLineHeight = Number.isFinite(v) && v >= 0 ? Math.min(4, v) : 0;
      }
      if (touched.has('translationOpacity')) {
        const v = Number(translationOpacitySel.value);
        next.translationOpacity =
          Number.isFinite(v) && v >= 0.2 && v <= 1 ? v : v === 0 ? 0 : 0.85;
      }
      if (touched.has('translationColor')) {
        const c = translationColorInput.value.trim();
        next.translationColor = /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '';
      }
      if (touched.has('ttsVoiceName')) next.ttsVoiceName = ttsVoiceSel.value;
      if (touched.has('themeMode')) {
        const mode = themeModeSel.value;
        next.themeMode = mode === 'light' || mode === 'dark' ? mode : 'auto';
      }
      if (touched.has('fallbackProviders')) {
        next.fallbackProviders = fallbackInput.value
          .split(/[,，\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
      if (touched.has('strongProvider')) next.strongProvider = strongProviderSel.value;
      if (touched.has('strongModel')) next.strongModel = strongModelInput.value.trim();
      if (touched.has('strongThreshold')) {
        const threshold = Number(strongThresholdInput.value);
        next.strongThreshold =
          Number.isFinite(threshold) && threshold > 0 ? Math.max(200, Math.round(threshold)) : 1200;
      }
      // 兜底仅在本轮确实写了模型时生效：LLM 引擎下模型名为空会导致请求体缺 model 直接报错，
      // 回退到该引擎的预设模型而不是保存空串。
      const currentProvider = PROVIDERS.find((x) => x.id === next.provider);
      if (
        touched.has('model') &&
        !next.model &&
        currentProvider?.type === 'llm' &&
        currentProvider.defaultModel
      ) {
        next.model = currentProvider.defaultModel;
        if (!modelField.hidden && !modelText.hidden) modelText.value = next.model;
      }

      cfg = next;
      await configItem.setValue({ ...next, apiKeys: { ...next.apiKeys } });
    });

    saveQueue = write.then(
      () => setStatus('已保存 ✓', false, 1500),
      () => {
        // 写失败：归还待保存标记，重试/下次输入仍会带上这些字段。
        touched.forEach((k) => dirtyFields.add(k));
        setStatus('保存失败，请重试', true);
      },
    );
    return write.then(
      () => true,
      () => false,
    );
  }

  function scheduleSave(delay = 400) {
    if (inputSaveTimer) clearTimeout(inputSaveTimer);
    inputSaveTimer = setTimeout(() => {
      inputSaveTimer = null;
      void save();
    }, delay);
  }

  // Key 输入框默认掩码：允许用户切到明文核对有没有粘错（Key 只存本地，仍不上传任何中间服务）。
  keyToggle?.addEventListener('click', () => {
    const reveal = keyInput.type === 'password';
    keyInput.type = reveal ? 'text' : 'password';
    keyToggle.textContent = reveal ? '隐藏' : '显示';
    keyToggle.setAttribute('aria-label', reveal ? '隐藏 API Key' : '显示 API Key');
    keyInput.focus();
  });
  // 一边输入一边消掉「需要 Key」提示，用户能立刻确认填进去了
  keyInput.addEventListener('input', syncKeyGuide);

  providerSel.addEventListener('change', () => {
    markDirty('provider');
    // Key 输入框已编辑但尚未落库时，先把它提交给「切换前」的服务商：
    // 否则切引擎后保存会把旧服务商的 Key 误存到新服务商名下。
    // 失败时保留 (oldProvider, editedKey) 闭包供重试，避免归属错位。
    if (dirtyFields.has('apiKey') && cfg.provider !== providerSel.value) {
      const oldProvider = cfg.provider;
      const editedKey = keyInput.value.trim();
      saveQueue = saveQueue
        .catch(() => {})
        .then(async () => {
          if (configLoadFailed) return;
          const latest = normalizeConfig(await configItem.getValue().catch(() => cfg));
          const merged = { ...latest, apiKeys: { ...latest.apiKeys } };
          if (editedKey) merged.apiKeys[oldProvider] = editedKey;
          else delete merged.apiKeys[oldProvider];
          await configItem.setValue(merged);
        })
        .catch(() => {
          // 写失败：把 Key 还原到输入框并标脏，用户下次操作即按原归属重试。
          dirtyFields.add('apiKey');
          keyInput.value = editedKey;
          cfg.provider = oldProvider;
          setStatus('保存失败：切换引擎前的 API Key 未保存，请重试', true);
        });
    }
    dirtyFields.delete('apiKey');
    cfg = withProviderApiKey(cfg, keyInput.value);
    cfg.provider = providerSel.value;
    refreshSelectTitles();
    fillModels(cfg.provider);
    const p = PROVIDERS.find((x) => x.id === cfg.provider);
    // 自定义引擎没有预设端点/模型，切换到它时保留用户已配置的值；
    // 快速面板与完整表单必须使用相同规则，否则两边切换会互相清空配置。
    if (cfg.provider !== 'custom') {
      cfg.model = p?.defaultModel || '';
      cfg.baseUrl = p?.baseUrl || '';
      // 引擎切换会连带重置模型与端点，三者作为一组意图一起落库。
      markDirty('model', 'baseUrl');
    }
    fill();
    save();
  });

  modelSel.addEventListener('change', () => {
    const custom = modelSel.value === customModelValue;
    modelText.hidden = !custom;
    if (custom) {
      // 进入自定义模式时保留当前已配置的自定义模型名：若当前模型是预设项之一
      // 则置空让用户输入；否则（本来就是自定义模型）必须回填，置空会让下一次
      // 任意字段的保存把 cfg.model 静默抹掉（数据丢失）。
      const known = Array.from(modelSel.options).some((o) => o.value === cfg.model);
      modelText.value = known ? '' : cfg.model || '';
      modelText.focus();
      return;
    }
    markDirty('model');
    void save();
  });

  [
    modelText,
    baseInput,
    keyInput,
    sourceSel,
    targetSel,
    toneSel,
    promptInput,
    cacheChk,
    glossaryChk,
    glossaryInput,
    customVisionChk,
    streamingChk,
    contextChk,
    qualityChk,
    autoLearnChk,
    sentenceChk,
    fallbackInput,
    strongProviderSel,
    strongModelInput,
    strongThresholdInput,
    glossaryTermLimitSel,
    hoverTranslateChk,
    inputTranslateChk,
    translationStyleSel,
    dualModeSel,
    translationFontSizeSel,
    translationLineHeightSel,
    translationOpacitySel,
    translationColorInput,
    themeModeSel,
    ttsVoiceSel,
    translateModeSel,
  ].forEach((el) =>
    el.addEventListener('change', () => {
      const f = el.getAttribute('data-f') || '';
      markDirty(f === 'modelText' ? 'model' : f);
      save();
      refreshSelectTitles();
    }),
  );

  // checkbox 勾选样式同步（:has 兼容替代）
  [cacheChk, glossaryChk, customVisionChk, streamingChk, contextChk, qualityChk, autoLearnChk,
    sentenceChk, hoverTranslateChk, inputTranslateChk].forEach((el) => {
    el.addEventListener('change', syncCheckState);
  });

  [
    modelText,
    baseInput,
    keyInput,
    promptInput,
    glossaryInput,
    fallbackInput,
    strongModelInput,
  ].forEach((el) => {
    el.addEventListener('input', () => {
      const f = el.getAttribute('data-f') || '';
      markDirty(f === 'modelText' ? 'model' : f);
      scheduleSave();
    });
  });
  window.addEventListener(
    'pagehide',
    () => {
      if (!inputSaveTimer) return;
      clearTimeout(inputSaveTimer);
      inputSaveTimer = null;
      void save();
    },
    { once: true },
  );

  // ===== 朗读人声下拉：按目标语言动态填充（异步语音列表就绪后重刷）=====
  function refreshVoiceOptions() {
    if (!ttsVoiceSel) return;
    const want = cfg.ttsVoiceName || '';
    const tag = langTagOf(targetSel.value || cfg.targetLang);
    const voices = listVoicesForLang(tag);
    const prev = ttsVoiceSel.value;
    ttsVoiceSel.replaceChildren();
    const autoOpt = document.createElement('option');
    autoOpt.value = '';
    autoOpt.textContent =
      voices.length > 0 ? `自动选择最佳人声（${voices.length} 个可选）` : '自动（使用系统默认人声）';
    ttsVoiceSel.appendChild(autoOpt);
    for (const v of voices) {
      const o = document.createElement('option');
      o.value = v.name;
      o.textContent = v.online ? `★ ${v.name}` : v.name;
      ttsVoiceSel.appendChild(o);
    }
    // 恢复已存人声；若该人声不属于当前语言列表则回退自动
    if (want && voices.some((v) => v.name === want)) ttsVoiceSel.value = want;
    else ttsVoiceSel.value = prev && voices.some((v) => v.name === prev) ? prev : '';
  }
  onVoicesReady(() => {
    try {
      refreshVoiceOptions();
    } catch {
      /* 下拉刷新失败不影响其他设置 */
    }
  });
  targetSel.addEventListener('change', () => {
    try {
      refreshVoiceOptions();
    } catch {
      /* 忽略 */
    }
  });
  // 缓存管理：显示当前条数；清空后立即刷新并提示。
  async function refreshCacheCount() {    if (!cacheCountEl) return;
    try {
      const stats = getCacheStats();
      cacheCountEl.textContent = String(stats?.count ?? 0);
    } catch {
      /* 计数失败保持占位 */
    }
  }
  void refreshCacheCount();
  cacheClearBtn?.addEventListener('click', async () => {
    if (!cacheClearBtn || cacheClearBtn.disabled) return;
    cacheClearBtn.disabled = true;
    try {
      await clearTranslateCache();
      setStatus('翻译缓存已清空 ✓', false, 2500);
    } catch {
      setStatus('缓存清空失败，请重试', true);
    } finally {
      cacheClearBtn.disabled = false;
      void refreshCacheCount();
    }
  });

  // ===== 剪贴板一键备份/恢复（所有面板通用，含 API Key）=====
  cfgCopyBtn?.addEventListener('click', async () => {
    if (configLoadFailed) { setStatus('读取设置失败，无法导出', true); return; }
    cfgCopyBtn.disabled = true;
    try {
      const snapshot = normalizeConfig(await configItem.getValue());
      const payload = JSON.stringify({ app: 'hao-fan', kind: 'settings', version: 1, config: snapshot });
      await navigator.clipboard.writeText(payload);
      setStatus('已复制全部配置（含 Key）到剪贴板 ✓', false, 3000);
    } catch (e) {
      setStatus('复制失败：' + (e instanceof Error ? e.message : String(e)), true);
    } finally {
      cfgCopyBtn.disabled = false;
    }
  });
  cfgPasteBtn?.addEventListener('click', async () => {
    if (cfgPasteBtn.disabled) return;
    cfgPasteBtn.disabled = true;
    try {
      const text = await navigator.clipboard.readText();
      let parsed: any;
      try { parsed = JSON.parse(text); } catch { throw new Error('剪贴板内容不是有效的 JSON'); }
      if (parsed?.app !== 'hao-fan' || parsed?.kind !== 'settings') throw new Error('不是好翻的配置数据');
      const sanitized = sanitizeImportedConfig(parsed.config);
      await configItem.setValue(sanitized);
      dirtyFields.clear();
      cfg = sanitized;
      fill();
      setStatus(`已从剪贴板恢复配置：引擎 ${sanitized.provider} ✓`, false, 4000);
    } catch (e) {
      setStatus('恢复失败：' + (e instanceof Error ? e.message : String(e)), true);
    } finally {
      cfgPasteBtn.disabled = false;
    }
  });
  // 测试连接：保存当前配置后翻译一句测试文本，验证 Key / 端点是否可用（P2-3）
  testBtn.addEventListener('click', async () => {
    const saved = await save(); // 先等配置落盘，再发测试请求，避免用旧配置误测
    if (!saved) return;
    setStatus('测试中…');
    testBtn.disabled = true;
    try {
      const res: any = await browser.runtime.sendMessage({
        type: 'TEST_CONNECTION',
      });
      if (res?.ok) {
        setStatus(`连接成功 ✓ 译文：「${res.translation}」`, false, 6000);
      } else {
        setStatus('连接失败：' + (res?.error || '未知错误'), true, 8000);
      }
    } catch (e: any) {
      setStatus('连接失败：' + (e?.message || String(e)), true, 8000);
    } finally {
      testBtn.disabled = false;
    }
  });

  if (!compact) {
    const hint = document.createElement('p');
    hint.className = 'ot-hint';
    hint.textContent =
      'API Key 仅保存在本地浏览器，并只发送给你选择的翻译服务商。快捷键 Alt+T 可直接翻译当前网页。';
    mount.insertAdjacentElement('beforebegin', hint);
  }

  // 站点偏好开关（页面内完整设置面板专用）
  const autoSiteInput = mount.querySelector('[data-site-ctx="auto"]') as HTMLInputElement | null;
  const pauseSiteInput = mount.querySelector('[data-site-ctx="pause"]') as HTMLInputElement | null;
  const alwaysSiteInput = mount.querySelector('[data-site-ctx="always"]') as HTMLInputElement | null;
  const neverSiteInput = mount.querySelector('[data-site-ctx="never"]') as HTMLInputElement | null;
  if (siteCtx) {
    autoSiteInput?.addEventListener('change', () => siteCtx.onAuto(autoSiteInput.checked));
    pauseSiteInput?.addEventListener('change', () => siteCtx.onPause(pauseSiteInput.checked));
    alwaysSiteInput?.addEventListener('change', () => siteCtx.onAlways(alwaysSiteInput.checked));
    neverSiteInput?.addEventListener('change', () => siteCtx.onNever(neverSiteInput.checked));
  }

  fill();
  setFormLoading(true);
  void configItem
    .getValue()
    .then((value) => {
      cfg = normalizeConfig(value);
      configLoadFailed = false;
      fill();
    })
    .catch(() => {
      configLoadFailed = true;
      setStatus('读取设置失败，当前显示默认配置；为防覆盖已暂停保存', true);
    })
    .finally(() => setFormLoading(false));

  // 所有设置入口都订阅同一份 storage 配置：popup、options、页内完整面板
  // 不再依赖各自调用方手工转发，任一面板修改后其它面板自动刷新。
  let unwatchConfig: (() => void) | null = null;
  try {
    const unwatch = configItem.watch((value) => {
      if (disposed) return;
      if (value) {
        cfg = normalizeConfig(value);
        configLoadFailed = false;
        fill();
      }
    });
    if (typeof unwatch === 'function') unwatchConfig = unwatch;
  } catch {
    /* storage 监听不可用时仍保留当前表单的本地保存能力 */
  }

  return {
    update: (next?: AppConfig) => {
      if (disposed) return;
      if (next) {
        cfg = normalizeConfig(next);
        // 外部传入了有效配置：解除读取失败的保存封锁。
        configLoadFailed = false;
      }
      fill();
    },
    updateSiteState: (auto, paused, always, never) => {
      if (disposed) return;
      if (auto !== undefined && autoSiteInput) autoSiteInput.checked = auto;
      if (paused !== undefined && pauseSiteInput) pauseSiteInput.checked = paused;
      if (always !== undefined && alwaysSiteInput) alwaysSiteInput.checked = always;
      if (never !== undefined && neverSiteInput) neverSiteInput.checked = never;
      syncCheckState();
    },
    resetDirty: (next?: AppConfig) => {
      dirtyFields.clear();
      if (inputSaveTimer) {
        clearTimeout(inputSaveTimer);
        inputSaveTimer = null;
      }
      if (next) {
        cfg = normalizeConfig(next);
        configLoadFailed = false;
      }
      fill();
    },
    dispose: () => {
      disposed = true;
      // 冲刷挂起的防抖保存：页内面板关得太快时不得吞掉最后一次编辑
      if (inputSaveTimer) {
        clearTimeout(inputSaveTimer);
        inputSaveTimer = null;
        void save();
      }
      try {
        unwatchConfig?.();
      } catch {
        /* 重复退订或监听不可用时静默 */
      }
      unwatchConfig = null;
    },
  };
}
