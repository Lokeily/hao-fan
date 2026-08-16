import { configItem } from './storage.ts';
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
  onAuto: (enabled: boolean) => void;
  onPause: (paused: boolean) => void;
}

export interface ConfigFormApi {
  /**
   * 用最新配置重填表单（值相同则不动控件，避免打断输入）。
   * next 传入最新配置快照（如 storage watch 回调），否则用当前内存值。
   */
  update: (next?: AppConfig) => void;
  /** 外部同步站点开关状态（可只传其一） */
  updateSiteState: (auto?: boolean, paused?: boolean) => void;
}

export function buildConfigForm(
  mount: HTMLElement,
  compact: boolean,
  siteCtx?: SettingsSiteCtx,
): ConfigFormApi {
  let cfg: AppConfig = normalizeConfig(configItem.defaultValue);

  const advancedFields = `
    <div class="ot-field-grid">
      <label class="ot-field ot-field-wide">API Base URL
        <input data-f="baseUrl" type="url" inputmode="url" placeholder="https://..." />
      </label>
      <label class="ot-check ot-field-wide" data-custom-vision hidden>
        <input data-f="customVision" type="checkbox" />
        <span><strong>接口支持图片模型</strong><small>仅为兼容视觉输入的自定义接口开启</small></span>
      </label>
      <label class="ot-field ot-field-wide">系统提示词
        <textarea data-f="systemPrompt" rows="3" placeholder="留空使用内置提示词"></textarea>
      </label>
      <label class="ot-field ot-field-wide">我的术语表 <span>每行：源词=译文</span>
        <textarea data-f="customGlossary" rows="3" placeholder="GitHub=GitHub\nrepository=代码仓库\nissue=工单"></textarea>
      </label>
      <label class="ot-field ot-field-wide">备用引擎（故障转移） <span>主引擎限流/报错时按顺序切换，逗号分隔</span>
        <input data-f="fallbackProviders" type="text" placeholder="deepl, openai" />
      </label>
      <label class="ot-field">长文强模型·引擎
        <select data-f="strongProvider"><option value="">不启用</option></select>
      </label>
      <label class="ot-field">长文强模型·模型
        <input data-f="strongModel" type="text" placeholder="如 gpt-4o" />
      </label>
      <label class="ot-field">长文路由阈值（字符）
        <input data-f="strongThreshold" type="number" min="200" step="100" />
      </label>
    </div>
  `;

  const formMarkup = `
    <form class="ot-form" autocomplete="off">
      <section class="ot-form-section">
        <h2>模型服务</h2>
        <div class="ot-field-grid">
          <label class="ot-field">翻译引擎
            <select data-f="provider"></select>
          </label>
          <label class="ot-field" data-f="modelField">模型
            <select data-f="model"></select>
            <input data-f="modelText" type="text" placeholder="如 gpt-4o" hidden />
          </label>
          <label class="ot-field ot-field-wide">API Key
            <input data-f="apiKey" type="password" autocomplete="new-password" placeholder="当前服务商专用，保存在本地" />
          </label>
        </div>
      </section>

      <section class="ot-form-section">
        <h2>翻译偏好</h2>
        <div class="ot-field-grid ot-lang-row">
          <label class="ot-field">源语言
            <select data-f="sourceLang"></select>
          </label>
          <label class="ot-field">目标语言
            <select data-f="targetLang"></select>
          </label>
          <label class="ot-field ot-field-wide">翻译风格
            <select data-f="tone">
              <option value="自然流畅">自然流畅（推荐）</option>
              <option value="正式书面">正式书面</option>
              <option value="轻松口语">轻松口语</option>
              <option value="简洁精炼">简洁精炼</option>
            </select>
          </label>
        </div>
      </section>

      ${
        siteCtx
          ? `<section class="ot-form-section">
        <h2>本站</h2>
        <div class="ot-switches">
          <label class="ot-check" id="ot-full-auto">
            <input type="checkbox" data-site-ctx="auto" ${siteCtx.autoTranslate ? 'checked' : ''} />
            <span><strong>自动翻译此站</strong><small>打开 ${siteCtx.host} 的页面时自动开始翻译</small></span>
          </label>
          <label class="ot-check" id="ot-full-pause">
            <input type="checkbox" data-site-ctx="pause" ${siteCtx.paused ? 'checked' : ''} />
            <span><strong>暂停本站翻译</strong><small>立即停止翻译并清理译文</small></span>
          </label>
        </div>
      </section>`
          : ''
      }

      <section class="ot-form-section">
        <h2>节省 Token</h2>
        <div class="ot-switches">
          <label class="ot-check">
            <input data-f="cacheEnabled" type="checkbox" />
            <span><strong>翻译缓存</strong><small>重复内容直接复用译文</small></span>
          </label>
          <label class="ot-check">
            <input data-f="glossaryEnabled" type="checkbox" />
            <span><strong>术语库</strong><small>本地命中术语，不调用模型</small></span>
          </label>
          <label class="ot-check">
            <input data-f="sentenceCache" type="checkbox" />
            <span><strong>句子级缓存</strong><small>按句缓存，SPA 微变只重译变化句</small></span>
          </label>
        </div>
        <div class="ot-field-grid">
          <label class="ot-field ot-field-wide">术语注入上限
            <span>每批提示词注入的术语条数，越低越省 Token</span>
            <select data-f="glossaryTermLimit">
              <option value="0">关闭（不注入术语，最省）</option>
              <option value="6">6 条（更省）</option>
              <option value="12">12 条（推荐）</option>
              <option value="24">24 条（译名更一致）</option>
            </select>
          </label>
        </div>
      </section>

      <section class="ot-form-section">
        <h2>智能增强</h2>
        <div class="ot-switches">
          <label class="ot-check">
            <input data-f="streaming" type="checkbox" />
            <span><strong>流式输出</strong><small>首段边生成边显示，首字延迟更低</small></span>
          </label>
          <label class="ot-check">
            <input data-f="contextAware" type="checkbox" />
            <span><strong>上下文感知</strong><small>结合页面标题与前段译文，长文更连贯</small></span>
          </label>
          <label class="ot-check">
            <input data-f="qualityCheck" type="checkbox" />
            <span><strong>质量自检</strong><small>校验数字 / 链接 / 代码不被遗漏</small></span>
          </label>
          <label class="ot-check">
            <input data-f="autoLearnTerms" type="checkbox" />
            <span><strong>译文可编辑 · 术语自学习</strong><small>修改译文自动沉淀进术语库</small></span>
          </label>
          <label class="ot-check">
            <input data-f="hoverTranslate" type="checkbox" />
            <span><strong>悬停翻译</strong><small>鼠标悬停段落即显示译文气泡</small></span>
          </label>
          <label class="ot-check">
            <input data-f="inputTranslate" type="checkbox" />
            <span><strong>输入框翻译</strong><small>网页输入框聚焦时提供翻译入口</small></span>
          </label>
        </div>
        <div class="ot-field-grid">
          <label class="ot-field ot-field-wide">译文显示样式
            <span>译文在原文下方的呈现方式</span>
            <select data-f="translationStyle">
              <option value="plain">默认（清淡无装饰）</option>
              <option value="dashed">蓝色虚线分隔</option>
              <option value="underline">蓝色下划线</option>
              <option value="highlight">浅蓝高亮块</option>
            </select>
          </label>
        </div>
      </section>

      ${
        compact
          ? `<details class="ot-advanced"><summary>高级设置</summary>${advancedFields}</details>`
          : `<section class="ot-form-section"><h2>高级设置</h2>${advancedFields}</section>`
      }

      <div class="ot-form-actions">
        <button type="button" data-f="test" class="ot-test-btn">测试连接</button>
        <div class="ot-status" role="status" aria-live="polite"></div>
      </div>
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
  const sourceSel = mount.querySelector('[data-f=sourceLang]') as HTMLSelectElement;
  const targetSel = mount.querySelector('[data-f=targetLang]') as HTMLSelectElement;
  const toneSel = mount.querySelector('[data-f=tone]') as HTMLSelectElement;
  const promptInput = mount.querySelector('[data-f=systemPrompt]') as HTMLTextAreaElement;
  const cacheChk = mount.querySelector('[data-f=cacheEnabled]') as HTMLInputElement;
  const glossaryChk = mount.querySelector('[data-f=glossaryEnabled]') as HTMLInputElement;
  const glossaryInput = mount.querySelector('[data-f=customGlossary]') as HTMLTextAreaElement;
  const glossaryLimitInput = mount.querySelector('[data-f=glossaryInjectionLimit]') as HTMLInputElement;
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
  const fallbackInput = mount.querySelector('[data-f=fallbackProviders]') as HTMLInputElement;
  const strongProviderSel = mount.querySelector('[data-f=strongProvider]') as HTMLSelectElement;
  const strongModelInput = mount.querySelector('[data-f=strongModel]') as HTMLInputElement;
  const strongThresholdInput = mount.querySelector('[data-f=strongThreshold]') as HTMLInputElement;
  const testBtn = mount.querySelector('[data-f=test]') as HTMLButtonElement;
  const status = mount.querySelector('.ot-status') as HTMLElement;
  const advanced = mount.querySelector('.ot-advanced') as HTMLDetailsElement | null;
  const customModelValue = '__haofan_custom_model__';
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  let saveQueue: Promise<void> = Promise.resolve();
  let inputSaveTimer: ReturnType<typeof setTimeout> | null = null;

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

  PROVIDERS.forEach((p) => {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name + (p.needsKey ? '' : '（免 Key）');
    providerSel.appendChild(o);
    const fo = document.createElement('option');
    fo.value = p.id;
    fo.textContent = p.name + (p.needsKey ? '' : '（免 Key）');
    fallbackProviderSel.appendChild(fo);
  });
  const refreshSelectTitles = () => {
    providerSel.title = providerSel.options[providerSel.selectedIndex]?.textContent || '';
    modelSel.title = modelSel.options[modelSel.selectedIndex]?.textContent || modelSel.value;
    sourceSel.title = sourceSel.value;
    targetSel.title = targetSel.value;
  };
  PROVIDERS.forEach((p) => {
    if (p.id !== 'google') {
      const so = document.createElement('option');
      so.value = p.id;
      so.textContent = p.name + (p.needsKey ? '' : '（免 Key）');
      strongProviderSel.appendChild(so);
    }
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
    if (advanced && providerId === 'custom') advanced.open = true;
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
    // 仅引擎变化时重建模型下拉；开关切换等外部同步不应反复重建（性能/闪烁）
    if (providerSel.value !== cfg.provider) {
      providerSel.value = cfg.provider;
      fillModels(cfg.provider);
    }
    const hasModels = !modelSel.hidden;
    const inSelect = hasModels && Array.from(modelSel.options).some((o) => o.value === cfg.model);
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
    // 值相同则不写回，避免外部同步打断正在输入的控件
    const setIfDiff = (
      el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
      value: string | boolean,
    ) => {
      if (el instanceof HTMLInputElement && el.type === 'checkbox') {
        if (el.checked !== Boolean(value)) el.checked = Boolean(value);
      } else if (String(el.value) !== String(value)) {
        el.value = String(value);
      }
    };
    setIfDiff(baseInput, cfg.baseUrl);
    setIfDiff(keyInput, getProviderApiKey(cfg));
    setIfDiff(sourceSel, cfg.sourceLang);
    setIfDiff(targetSel, cfg.targetLang);
    setIfDiff(toneSel, cfg.tone || '自然流畅');
    setIfDiff(promptInput, cfg.systemPrompt);
    setIfDiff(cacheChk, cfg.cacheEnabled);
    setIfDiff(glossaryChk, cfg.glossaryEnabled !== false);
    setIfDiff(glossaryInput, cfg.customGlossary || '');
    setIfDiff(customVisionChk, cfg.customVision === true);
    setIfDiff(streamingChk, cfg.streaming !== false);
    setIfDiff(contextChk, cfg.contextAware !== false);
    setIfDiff(qualityChk, cfg.qualityCheck !== false);
    setIfDiff(autoLearnChk, cfg.autoLearnTerms !== false);
    setIfDiff(sentenceChk, cfg.sentenceCache !== false);
    setIfDiff(glossaryTermLimitSel, String(cfg.glossaryTermLimit ?? 12));
    setIfDiff(hoverTranslateChk, cfg.hoverTranslate !== false);
    setIfDiff(inputTranslateChk, cfg.inputTranslate !== false);
    setIfDiff(translationStyleSel, cfg.translationStyle || 'plain');
    syncCheckState();
    refreshSelectTitles();
  }

  function save(): Promise<boolean> {
    cfg.provider = providerSel.value;
    // 取当前可见的模型字段（P1-2）
    cfg.model = modelField.hidden
      ? ''
      : !modelSel.hidden && modelSel.value !== customModelValue
        ? modelSel.value
        : modelText.value.trim();
    cfg.baseUrl = baseInput.value.trim();
    cfg = withProviderApiKey(cfg, keyInput.value);
    cfg.sourceLang = sourceSel.value;
    cfg.targetLang = targetSel.value;
    cfg.tone = toneSel.value;
    cfg.systemPrompt = promptInput.value.trim();
    cfg.cacheEnabled = cacheChk.checked;
    cfg.glossaryEnabled = glossaryChk.checked;
    cfg.customGlossary = glossaryInput.value;
    cfg.glossaryInjectionLimit = Math.max(0, Math.min(60, Number(glossaryLimitInput.value) || 24));
    cfg.customVision = customVisionChk.checked;
    cfg.streaming = streamingChk.checked;
    cfg.contextAware = contextChk.checked;
    cfg.qualityCheck = qualityChk.checked;
    cfg.autoLearnTerms = autoLearnChk.checked;
    cfg.sentenceCache = sentenceChk.checked;
    cfg.glossaryTermLimit = Number(glossaryTermLimitSel.value) || 12;
    cfg.hoverTranslate = hoverTranslateChk.checked;
    cfg.inputTranslate = inputTranslateChk.checked;
    cfg.translationStyle = translationStyleSel.value;
    cfg.fallbackProviders = fallbackInput.value
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    cfg.strongProvider = strongProviderSel.value;
    cfg.strongModel = strongModelInput.value.trim();
    cfg.strongThreshold = Number(strongThresholdInput.value) || 1200;
    const snapshot: AppConfig = { ...cfg, apiKeys: { ...cfg.apiKeys } };
    const write = saveQueue.catch(() => {}).then(() => configItem.setValue(snapshot));
    saveQueue = write.then(
      () => setStatus('已保存 ✓', false, 1500),
      () => setStatus('保存失败，请重试', true),
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

  providerSel.addEventListener('change', () => {
    cfg = withProviderApiKey(cfg, keyInput.value);
    cfg.provider = providerSel.value;
    refreshSelectTitles();
    fillModels(cfg.provider);
    const p = PROVIDERS.find((x) => x.id === cfg.provider);
    cfg.model = p?.defaultModel || '';
    cfg.baseUrl = p?.baseUrl || '';
    fill();
    save();
  });

  modelSel.addEventListener('change', () => {
    const custom = modelSel.value === customModelValue;
    modelText.hidden = !custom;
    if (custom) {
      modelText.value = '';
      modelText.focus();
      return;
    }
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
  ].forEach((el) =>
    el.addEventListener('change', () => {
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
    el.addEventListener('input', () => scheduleSave());
  });

  fallbackProviderSel.addEventListener('change', () => {
    const p = PROVIDERS.find((x) => x.id === fallbackProviderSel.value);
    if (p?.baseUrl && !fallbackBaseUrlInput.value.trim()) fallbackBaseUrlInput.value = p.baseUrl;
    void save();
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
        setStatus(`连接成功 ✓ 译文：「${res.translation}」`);
      } else {
        setStatus('连接失败：' + (res?.error || '未知错误'), true);
      }
    } catch (e: any) {
      setStatus('连接失败：' + (e?.message || String(e)), true);
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
  if (siteCtx && autoSiteInput && pauseSiteInput) {
    autoSiteInput.addEventListener('change', () => siteCtx.onAuto(autoSiteInput.checked));
    pauseSiteInput.addEventListener('change', () => siteCtx.onPause(pauseSiteInput.checked));
  }

  fill();
  setFormLoading(true);
  void configItem
    .getValue()
    .then((value) => {
      cfg = normalizeConfig(value);
      fill();
    })
    .catch(() => setStatus('读取设置失败，当前显示默认配置', true))
    .finally(() => setFormLoading(false));

  return {
    update: (next?: AppConfig) => {
      if (next) cfg = normalizeConfig(next);
      fill();
    },
    updateSiteState: (auto, paused) => {
      if (auto !== undefined && autoSiteInput) autoSiteInput.checked = auto;
      if (paused !== undefined && pauseSiteInput) pauseSiteInput.checked = paused;
      syncCheckState();
    },
  };
}
