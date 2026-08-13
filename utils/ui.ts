import { configItem } from './storage';
import { PROVIDERS } from './providers';
import { LANGUAGES } from './languages';
import { browser } from 'wxt/browser';
import { getProviderApiKey, normalizeConfig, withProviderApiKey, type AppConfig } from './config';

// Options 页与 Popup 共用的配置表单。compact=true 时不显示提示文案（给 popup 用）。
export function buildConfigForm(mount: HTMLElement, compact: boolean) {
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
  const customVisionChk = mount.querySelector('[data-f=customVision]') as HTMLInputElement;
  const customVisionRow = mount.querySelector('[data-custom-vision]') as HTMLElement;
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

  function fill() {
    providerSel.value = cfg.provider;
    fillModels(cfg.provider);
    // 回填模型：若当前 model 在下拉里则选下拉，否则填入文本框
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
    baseInput.value = cfg.baseUrl;
    keyInput.value = getProviderApiKey(cfg);
    sourceSel.value = cfg.sourceLang;
    targetSel.value = cfg.targetLang;
    toneSel.value = cfg.tone || '自然流畅';
    promptInput.value = cfg.systemPrompt;
    cacheChk.checked = cfg.cacheEnabled;
    glossaryChk.checked = cfg.glossaryEnabled !== false;
    glossaryInput.value = cfg.customGlossary || '';
    customVisionChk.checked = cfg.customVision === true;
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
    cfg.customVision = customVisionChk.checked;
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
  ].forEach((el) => el.addEventListener('change', save));

  [modelText, baseInput, keyInput, promptInput, glossaryInput].forEach((el) => {
    el.addEventListener('input', () => scheduleSave());
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
    hint.textContent = 'API Key 仅保存在本地浏览器，并只发送给你选择的翻译服务商。';
    mount.insertAdjacentElement('beforebegin', hint);
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
}
