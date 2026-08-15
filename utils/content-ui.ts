// 内容脚本的纯 UI 构建辅助（从 entrypoints/content.ts 拆分）。
// 只负责「用原生 DOM 构造隔离良好的界面元素」，不持有页面翻译状态，
// 因此可独立维护与测试。

// ===== 译文嵌入节点 =====
// 直接在原文文字下方插入译文节点，形成原文与译文的对照显示，嵌入文档流
// 随页面滚动/缩放自然跟随，不产生叠加层遮挡。
// 用 <span> + display:block（而非 <div>）渲染，避免 <div> 被塞进 <p>/<li>/<a>
// 等不可含块级元素的容器时浏览器自动闭合父节点，导致译文错位/堆叠。
export interface TranslationNodeOptions {
  sourceText?: string;
  onEdit?: (newTranslation: string) => void;
  style?: string;
}

export function createTranslationNode(
  translation: string,
  anchor: Element,
  options?: TranslationNodeOptions,
): HTMLSpanElement {
  const host = document.createElement('span');
  host.className = 'ot-translation';
  host.dataset.haofanTranslation = 'true';
  host.setAttribute('role', 'note');
  if (options?.style) host.dataset.style = options.style;
  const sourceStyle = getComputedStyle(anchor);
  const sourceSize = Number.parseFloat(sourceStyle.fontSize) || 14;
  const translationSize = Math.min(18, Math.max(12, sourceSize));
  host.style.setProperty('--ot-source-color', sourceStyle.color);
  host.style.setProperty('--ot-source-font', sourceStyle.fontFamily);
  host.style.setProperty('--ot-source-size', `${translationSize}px`);
  host.style.setProperty('--ot-source-align', sourceStyle.textAlign || 'start');
  host.style.setProperty('all', 'initial', 'important');
  host.style.setProperty('display', 'block', 'important');
  host.style.setProperty('position', 'relative', 'important');
  host.style.setProperty('box-sizing', 'border-box', 'important');
  host.style.setProperty('width', 'auto', 'important');
  host.style.setProperty('max-width', '100%', 'important');
  host.style.setProperty('min-width', '0', 'important');
  host.style.setProperty('height', 'auto', 'important');
  host.style.setProperty('max-height', 'none', 'important');
  host.style.setProperty('overflow', 'visible', 'important');
  host.style.setProperty('clear', 'both', 'important');
  host.style.setProperty('margin', '2px 0 5px', 'important');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { color-scheme: light dark; }
    .text {
      display: block;
      box-sizing: border-box;
      width: 100%;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--ot-source-color, currentColor);
      font-family: var(--ot-source-font, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
      font-size: var(--ot-source-size, 14px);
      font-weight: 400;
      line-height: 1.5;
      letter-spacing: 0;
      text-align: var(--ot-source-align, start);
      opacity: 0.82;
      text-decoration: none;
      text-indent: 0;
      direction: auto;
      overflow-wrap: anywhere;
      white-space: normal;
      transition: opacity 0.18s ease;
    }
    .text.is-pending {
      opacity: 0.45;
      animation: ot-pulse 1.2s ease-in-out infinite;
    }
    /* 译文显示样式：plain / dashed / underline / highlight */
    :host([data-style="dashed"]) .text { border-bottom: 1px dashed rgba(0, 122, 255, 0.45); }
    :host([data-style="underline"]) .text { border-bottom: 1px solid rgba(0, 122, 255, 0.35); }
    :host([data-style="highlight"]) .text {
      background: rgba(0, 122, 255, 0.1);
      border-radius: 4px;
      padding: 1px 4px;
    }
    @keyframes ot-pulse {
      0%, 100% { opacity: 0.35; }
      50% { opacity: 0.6; }
    }
    .text:focus { outline: none; opacity: 1; }
    :host([data-quality="warn"]) .text {
      border-bottom: 1px dashed rgba(255, 159, 10, 0.75);
      cursor: help;
    }
    .edit-btn {
      position: absolute;
      top: -2px;
      right: -2px;
      width: 22px;
      height: 22px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: rgba(28, 28, 30, 0.72);
      color: #fff;
      font-size: 12px;
      line-height: 1;
      cursor: pointer;
      opacity: 0;
      transform: translateY(-2px) scale(0.9);
      transition: opacity 0.16s ease, transform 0.16s ease, background 0.16s ease;
      pointer-events: none;
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
    }
    :host(:hover) .edit-btn { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
    .edit-btn:hover { background: rgba(28, 28, 30, 0.92); }
    .edit-btn:focus-visible { opacity: 1; outline: 2px solid rgba(0,122,255,0.6); outline-offset: 2px; }
    :host([data-edited="true"]) .edit-btn::after {
      content: "";
      position: absolute;
      right: 2px;
      bottom: 2px;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #34c759;
    }
    @media (prefers-color-scheme: dark) {
      .text { opacity: 0.9; }
    }
  `;
  const text = document.createElement('span');
  text.className = 'text';
  // 空译文（流式渲染中）显示"…"占位，让用户明确感知翻译进度。
  text.textContent = translation || '…';
  if (!translation) text.classList.add('is-pending');
  shadow.append(style, text);

  if (options?.onEdit) {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'edit-btn';
    editBtn.title = '编辑译文并学习术语';
    editBtn.setAttribute('aria-label', '编辑译文');
    editBtn.textContent = '✎';
    const commit = () => {
      if (text.getAttribute('contenteditable') !== 'true') return;
      text.setAttribute('contenteditable', 'false');
      const next = text.textContent ?? '';
      const prev = host.dataset.translation ?? translation;
      if (next.trim() && next !== prev) {
        host.dataset.translation = next;
        host.dataset.edited = 'true';
        options.onEdit?.(next);
      } else {
        text.textContent = host.dataset.translation ?? translation;
      }
    };
    editBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (text.getAttribute('contenteditable') === 'true') {
        commit();
        return;
      }
      text.setAttribute('contenteditable', 'true');
      text.focus();
      const range = document.createRange();
      range.selectNodeContents(text);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        text.setAttribute('contenteditable', 'false');
        text.textContent = host.dataset.translation ?? translation;
      }
    });
    text.addEventListener('blur', commit);
    shadow.append(editBtn);
  }
  host.dataset.translation = translation;
  host.dataset.source = options?.sourceText ?? '';
  return host;
}

// ===== 错误提示弹窗 =====
// 返回挂载好的 host（含 Shadow DOM），关闭按钮触发 onAcknowledge。
export function createNoticeHost(
  title: string,
  message: string,
  onAcknowledge: () => void,
): HTMLElement {
  const host = document.createElement('div');
  host.id = 'ot-error-modal';
  host.dataset.haofanUi = 'true';
  host.style.setProperty('all', 'initial', 'important');
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('inset', '0', 'important');
  host.style.setProperty('z-index', '2147483647', 'important');
  host.style.setProperty('display', 'block', 'important');

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { color-scheme: light dark; }
    .backdrop {
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      display: grid;
      place-items: center;
      padding: 20px;
      background: rgba(0, 0, 0, 0.4);
      backdrop-filter: blur(3px);
      -webkit-backdrop-filter: blur(3px);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .dialog {
      box-sizing: border-box;
      width: min(420px, 100%);
      padding: 22px;
      border: 1px solid rgba(0, 0, 0, 0.08);
      border-radius: 14px;
      background: #fff;
      color: #202124;
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.28);
      animation: haofan-pop 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    @keyframes haofan-pop {
      from { transform: scale(0.96); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }
    h2 { margin: 0; font-size: 18px; line-height: 1.4; font-weight: 650; letter-spacing: 0; }
    p { margin: 10px 0 20px; color: #5f6368; font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
    .actions { display: flex; justify-content: flex-end; }
    button {
      box-sizing: border-box;
      min-height: 36px;
      padding: 0 16px;
      border: 0;
      border-radius: 6px;
      background: #007aff;
      color: #fff;
      font: 600 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      letter-spacing: 0;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    button:hover { background: #0069d9; }
    button:focus-visible { outline: 3px solid rgba(0, 122, 255, 0.35); outline-offset: 2px; }
    @media (prefers-color-scheme: dark) {
      .dialog {
        border-color: rgba(84, 84, 88, 0.4);
        background: rgba(28, 28, 30, 0.92);
        color: #f5f5f7;
      }
      p { color: #aeaeb2; }
    }
  `;
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const dialog = document.createElement('section');
  dialog.className = 'dialog';
  dialog.setAttribute('role', 'alertdialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'ot-notice-title');
  dialog.setAttribute('aria-describedby', 'ot-notice-message');
  const heading = document.createElement('h2');
  heading.id = 'ot-notice-title';
  heading.textContent = title;
  const body = document.createElement('p');
  body.id = 'ot-notice-message';
  body.textContent = message;
  const actions = document.createElement('div');
  actions.className = 'actions';
  const acknowledge = document.createElement('button');
  acknowledge.type = 'button';
  acknowledge.textContent = '我知道了';
  acknowledge.addEventListener('click', onAcknowledge);
  actions.appendChild(acknowledge);
  dialog.append(heading, body, actions);
  backdrop.appendChild(dialog);
  shadow.append(style, backdrop);
  acknowledge.focus({ preventScroll: true });
  return host;
}

// ===== 划词翻译浮层样式 =====
export function createSelectionUiStyle(): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = `
    :host { color-scheme: light dark; }
    * { box-sizing: border-box; }
    button { font: inherit; letter-spacing: 0; }
    .trigger {
      width: 36px; height: 36px; padding: 0; border: 0; border-radius: 50%;
      display: grid; place-items: center; background: #007aff; color: #fff;
      box-shadow: 0 4px 14px rgba(0, 0, 0, .25); cursor: pointer;
      font: 650 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
      transition: background 0.15s ease, transform 0.1s ease;
    }
    .trigger:hover { background: #0069d9; }
    .trigger:active { transform: scale(0.94); }
    .trigger:focus-visible, .action:focus-visible, .close:focus-visible {
      outline: 3px solid rgba(0, 122, 255, .35); outline-offset: 2px;
    }
    .panel {
      width: min(360px, calc(100vw - 16px)); max-height: min(360px, calc(100vh - 16px));
      overflow: auto; border: 1px solid rgba(0, 0, 0, 0.08); border-radius: 14px;
      background: #fff; color: #202124; box-shadow: 0 18px 48px rgba(0, 0, 0, .28);
      font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      animation: haofan-pop 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 10px 8px 12px; border-bottom: 1px solid #e8eaed; }
    .title { flex: 1; font-size: 13px; font-weight: 650; }
    .close { width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: #5f6368; cursor: pointer; font-size: 20px; line-height: 1; }
    .close:hover { background: rgba(60, 64, 67, .08); color: #202124; }
    .source { padding: 10px 12px 0; color: #6b7280; font-size: 12px; overflow-wrap: anywhere; }
    .result { min-height: 54px; padding: 8px 12px 12px; color: #202124; white-space: pre-wrap; overflow-wrap: anywhere; }
    .loading { color: #6b7280; }
    .actions { display: flex; justify-content: flex-end; padding: 0 10px 10px; }
    .action { min-height: 32px; padding: 0 10px; border: 1px solid #dadce0; border-radius: 6px; background: transparent; color: #1a73e8; cursor: pointer; font-weight: 600; }
    .action:hover { background: rgba(26, 115, 232, .07); }
    @media (prefers-color-scheme: dark) {
      .panel { border-color: #30363d; background: #161b22; color: #f0f6fc; }
      .head { border-color: #30363d; }
      .close, .source, .loading { color: #9da7b3; }
      .close:hover { background: rgba(255, 255, 255, .08); color: #f0f6fc; }
      .result { color: #f0f6fc; }
      .action { border-color: #3d444d; color: #58a6ff; }
    }
  `;
  return style;
}


// ===== 全局深浅色主题（不透明配色，保证任何网页上都可读） =====
// 注意：浮层宿主元素带 all:initial !important 防站点样式，shadow 内的 :host
// 规则会被内联样式覆盖——因此背景/文字色必须由 JS 直接内联设置。
export interface ThemeColors {
  surface: string;
  text: string;
  text2: string;
  border: string;
  muted: string;
}

export function themeColors(): ThemeColors {
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  return dark
    ? {
        surface: '#1c1c1e',
        text: '#f5f5f7',
        text2: '#aeaeb2',
        border: 'rgba(84,84,88,0.6)',
        muted: '#8e8e93',
      }
    : {
        surface: '#ffffff',
        text: '#1d1d1f',
        text2: '#6e6e73',
        border: 'rgba(60,60,67,0.18)',
        muted: '#8e8e93',
      };
}

// ===== 通用拖拽：把 host 通过 handle 拖到任意位置（fixed 定位） =====
// 位移小于 threshold 视为点击（不移动）；回调 onPos 在拖拽中更新位置。
export function makeDraggable(
  host: HTMLElement,
  handle: HTMLElement,
  onPos: (x: number, y: number) => void,
  threshold = 6,
): { suppressNextClick: () => boolean } {
  let startX = 0;
  let startY = 0;
  let origLeft = 0;
  let origTop = 0;
  let dragging = false;
  let moved = false;

  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = host.getBoundingClientRect();
    origLeft = rect.left;
    origTop = rect.top;
    host.style.transition = 'none';
    const onMove = (ev: PointerEvent) => {
      if (!dragging) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > threshold) {
        moved = true;
        // 首次真正移动时清除另一侧定位：left+right 同时存在会把 fixed 元素
        // 强制拉伸（宽度被压缩），且仅点击不移动时保留原定位。
        host.style.setProperty('right', 'auto', 'important');
        host.style.setProperty('bottom', 'auto', 'important');
      }
      if (!moved) return;
      ev.preventDefault();
      const maxX = window.innerWidth - host.offsetWidth;
      const maxY = window.innerHeight - host.offsetHeight;
      const x = Math.min(Math.max(0, origLeft + dx), Math.max(0, maxX));
      const y = Math.min(Math.max(0, origTop + dy), Math.max(0, maxY));
      // 用 !important：host 可能带 all:initial !important 的防干扰样式，普通赋值会被覆盖。
      host.style.setProperty('left', `${x}px`, 'important');
      host.style.setProperty('top', `${y}px`, 'important');
      onPos(x, y);
    };
    const onUp = () => {
      dragging = false;
      host.style.transition = '';
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
  });
  return {
    suppressNextClick: () => {
      const wasMoved = moved;
      moved = false;
      return wasMoved;
    },
  };
}

// ===== 页面内设置悬浮窗（轻量快速设置） =====
export interface SettingsPanelOptions {
  languages: string[];
  providers: { id: string; name: string; needsKey: boolean }[];
  targetLang: string;
  provider: string;
  sitePaused: boolean;
  siteHost: string;
  autoTranslate: boolean;
  hoverTranslate: boolean;
  inputTranslate: boolean;
  onAutoToggle: (enabled: boolean) => void;
  onHoverToggle: (enabled: boolean) => void;
  onInputToggle: (enabled: boolean) => void;
  onTargetLang: (value: string) => void;
  onProvider: (value: string) => void;
  onSiteToggle: (paused: boolean) => void;
  onOpenFullSettings: () => void;
  onClose: () => void;
  onDrag?: (x: number, y: number) => void;
}

export interface SettingsPanel {
  host: HTMLElement;
  update: (
    patch: Partial<
      Pick<
        SettingsPanelOptions,
        'targetLang' | 'provider' | 'sitePaused' | 'autoTranslate' | 'hoverTranslate' | 'inputTranslate'
      >
    >,
  ) => void;
}

export function createSettingsPanel(opts: SettingsPanelOptions): SettingsPanel {
  const host = document.createElement('div');
  host.id = 'ot-settings-panel';
  host.dataset.haofanUi = 'true';
  host.style.setProperty('all', 'initial', 'important');
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('z-index', '2147483647', 'important');
  host.style.setProperty('width', '320px', 'important');
  host.style.setProperty('border-radius', '16px', 'important');
  const theme = themeColors();
  host.style.setProperty('background', theme.surface, 'important');
  host.style.setProperty('color', theme.text, 'important');
  host.style.setProperty('border', `1px solid ${theme.border}`, 'important');
  host.style.setProperty('box-shadow', '0 16px 48px rgba(0,0,0,0.3)', 'important');
  host.style.setProperty(
    'font-family',
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif',
    'important',
  );
  host.style.setProperty('overflow', 'hidden', 'important');

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { color-scheme: light dark; }
    * { box-sizing: border-box; }
    .head {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 14px; cursor: grab;
      border-bottom: 1px solid ${theme.border};
      user-select: none;
    }
    .head:active { cursor: grabbing; }
    .title { flex: 1; font-size: 14px; font-weight: 700; letter-spacing: 0; }
    .close {
      width: 26px; height: 26px; padding: 0; border: 0; border-radius: 7px;
      background: transparent; color: ${theme.text2}; font-size: 16px; line-height: 1; cursor: pointer;
    }
    .close:hover { background: rgba(128,128,128,0.16); color: ${theme.text}; }
    .body { padding: 10px 12px 12px; }

    /* iOS inset grouped：分区卡片 */
    .group {
      margin-bottom: 10px;
      border-radius: 12px;
      background: ${theme.text === '#f5f5f7' ? 'rgba(255,255,255,0.08)' : 'rgba(60,60,67,0.06)'};
      overflow: hidden;
    }
    .group:last-child { margin-bottom: 0; }
    .group-title {
      padding: 10px 12px 4px;
      font-size: 11px; font-weight: 600;
      color: ${theme.text2}; letter-spacing: 0.2px;
      text-transform: uppercase;
    }
    .row {
      display: flex; align-items: center; gap: 10px;
      min-height: 44px; padding: 0 12px;
      border-bottom: 1px solid ${theme.border};
    }
    .row:last-child { border-bottom: 0; }
    .row-label {
      flex: 1; min-width: 0;
      font-size: 13px; color: ${theme.text};
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .row select {
      width: 128px; min-height: 32px; padding: 4px 8px;
      border: 1px solid ${theme.border}; border-radius: 9px;
      background: ${theme.surface}; color: ${theme.text};
      font-size: 12px; font-family: inherit;
      -webkit-appearance: none; appearance: none;
      background-image: linear-gradient(45deg, transparent 50%, ${theme.text2} 50%),
        linear-gradient(135deg, ${theme.text2} 50%, transparent 50%);
      background-position: calc(100% - 16px) 55%, calc(100% - 11px) 55%;
      background-size: 5px 5px;
      background-repeat: no-repeat;
    }
    .row select:focus { outline: 2px solid rgba(0,122,255,0.4); outline-offset: 1px; }

    /* iOS 开关：input 覆盖整个开关区域，点击任意位置都能切换 */
    .switch {
      position: relative;
      width: 46px; height: 28px; flex: 0 0 46px;
    }
    .switch input {
      position: absolute; inset: 0;
      width: 100%; height: 100%;
      margin: 0; padding: 0;
      opacity: 0; cursor: pointer; z-index: 1;
    }
    .track {
      display: flex; align-items: center;
      width: 100%; height: 100%; padding: 2px;
      border-radius: 14px;
      background: ${theme.text === '#f5f5f7' ? '#3a3a3c' : '#e5e5ea'};
      transition: background 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
      pointer-events: none;
    }
    .knob {
      width: 24px; height: 24px; flex: 0 0 24px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 2px 5px rgba(0, 0, 0, 0.3);
      transition: transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .switch input:checked + .track { background: #34c759; }
    .switch input:checked + .track .knob { transform: translateX(18px); }
    .switch input:focus-visible + .track { outline: 3px solid rgba(0,122,255,0.35); outline-offset: 1px; }

    .full {
      display: block; width: 100%; min-height: 36px; margin-top: 2px;
      border: 0; border-radius: 10px;
      background: rgba(0, 122, 255, 0.12);
      color: #007aff; font-size: 13px; font-weight: 600;
      font-family: inherit; cursor: pointer;
      transition: background 0.15s ease;
    }
    .full:hover { background: rgba(0, 122, 255, 0.2); }
    @media (prefers-color-scheme: dark) {
      .full { color: #0a84ff; background: rgba(10,132,255,0.2); }
      .full:hover { background: rgba(10,132,255,0.3); }
    }
  `;

  const head = document.createElement('div');
  head.className = 'head';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = '好翻 · 快速设置';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'close';
  close.textContent = '×';
  close.setAttribute('aria-label', '关闭设置');
  close.addEventListener('click', opts.onClose);
  head.append(title, close);

  const body = document.createElement('div');
  body.className = 'body';

  // 分组：翻译
  const translateGroup = document.createElement('div');
  translateGroup.className = 'group';
  const tTitle = document.createElement('div');
  tTitle.className = 'group-title';
  tTitle.textContent = '翻译';
  const langRow = document.createElement('div');
  langRow.className = 'row';
  const langLabel = document.createElement('span');
  langLabel.className = 'row-label';
  langLabel.textContent = '目标语言';
  const langSel = document.createElement('select');
  langSel.setAttribute('aria-label', '目标语言');
  opts.languages.forEach((name) => {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    langSel.appendChild(o);
  });
  langSel.value = opts.targetLang;
  langSel.addEventListener('change', () => opts.onTargetLang(langSel.value));
  langRow.append(langLabel, langSel);
  const provRow = document.createElement('div');
  provRow.className = 'row';
  const provLabel = document.createElement('span');
  provLabel.className = 'row-label';
  provLabel.textContent = '翻译引擎';
  const provSel = document.createElement('select');
  provSel.setAttribute('aria-label', '翻译引擎');
  opts.providers.forEach((p) => {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.needsKey ? p.name : `${p.name}（免 Key）`;
    provSel.appendChild(o);
  });
  provSel.value = opts.provider;
  provSel.addEventListener('change', () => opts.onProvider(provSel.value));
  provRow.append(provLabel, provSel);
  translateGroup.append(tTitle, langRow, provRow);

  // 分组：开关（iOS 风格）
  const makeSwitchRow = (
    label: string,
    checked: boolean,
    onChange: (on: boolean) => void,
    ariaLabel: string,
  ): HTMLDivElement => {
    const row = document.createElement('div');
    row.className = 'row';
    const rowLabel = document.createElement('span');
    rowLabel.className = 'row-label';
    rowLabel.textContent = label;
    const sw = document.createElement('span');
    sw.className = 'switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.setAttribute('aria-label', ariaLabel);
    const track = document.createElement('span');
    track.className = 'track';
    const knob = document.createElement('span');
    knob.className = 'knob';
    track.appendChild(knob);
    sw.append(input, track);
    input.addEventListener('change', () => onChange(input.checked));
    row.append(rowLabel, sw);
    return row;
  };

  const siteGroup = document.createElement('div');
  siteGroup.className = 'group';
  const sTitle = document.createElement('div');
  sTitle.className = 'group-title';
  sTitle.textContent = '本站';
  siteGroup.append(
    sTitle,
    makeSwitchRow('自动翻译此站', opts.autoTranslate, opts.onAutoToggle, '自动翻译此站'),
    makeSwitchRow(`暂停本站翻译（${opts.siteHost}）`, opts.sitePaused, opts.onSiteToggle, '暂停本站翻译'),
  );

  const featureGroup = document.createElement('div');
  featureGroup.className = 'group';
  const fTitle = document.createElement('div');
  fTitle.className = 'group-title';
  fTitle.textContent = '交互';
  featureGroup.append(
    fTitle,
    makeSwitchRow('悬停翻译', opts.hoverTranslate, opts.onHoverToggle, '悬停翻译'),
    makeSwitchRow('输入框翻译', opts.inputTranslate, opts.onInputToggle, '输入框翻译'),
  );

  const fullBtn = document.createElement('button');
  fullBtn.type = 'button';
  fullBtn.className = 'full';
  fullBtn.textContent = '打开完整设置';
  fullBtn.addEventListener('click', opts.onOpenFullSettings);

  body.append(translateGroup, siteGroup, featureGroup, fullBtn);
  shadow.append(style, head, body);
  document.documentElement.appendChild(host);

  makeDraggable(host, head, opts.onDrag ?? (() => {}));

  const update: SettingsPanel['update'] = (patch) => {
    if (patch.targetLang !== undefined && langSel.value !== patch.targetLang) {
      langSel.value = patch.targetLang;
    }
    if (patch.provider !== undefined && provSel.value !== patch.provider) {
      provSel.value = patch.provider;
    }
    const syncSwitch = (checked: boolean | undefined, ariaLabel: string) => {
      if (checked === undefined) return;
      const input = shadow.querySelector(`input[aria-label="${ariaLabel}"]`) as HTMLInputElement | null;
      if (input && input.checked !== checked) input.checked = checked;
    };
    syncSwitch(patch.sitePaused, '暂停本站翻译');
    syncSwitch(patch.autoTranslate, '自动翻译此站');
    syncSwitch(patch.hoverTranslate, '悬停翻译');
    syncSwitch(patch.inputTranslate, '输入框翻译');
  };

  return { host, update };
}

// ===== 悬停翻译气泡：鼠标悬停段落时显示译文小浮层 =====
export function createHoverBubble(
  source: string,
  onPinnedChange: (pinned: boolean) => void,
): { host: HTMLElement; setTranslation: (t: string) => void; setSource: (s: string) => void } {
  const host = document.createElement('div');
  host.id = 'ot-hover-bubble';
  host.dataset.haofanUi = 'true';
  host.style.setProperty('all', 'initial', 'important');
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('z-index', '2147483646', 'important');
  host.style.setProperty('width', '280px', 'important');
  host.style.setProperty('max-width', 'min(320px, calc(100vw - 24px))', 'important');
  host.style.setProperty('border-radius', '12px', 'important');
  const theme = themeColors();
  host.style.setProperty('background', theme.surface, 'important');
  host.style.setProperty('color', theme.text, 'important');
  host.style.setProperty('border', `1px solid ${theme.border}`, 'important');
  host.style.setProperty('box-shadow', '0 12px 36px rgba(0,0,0,0.28)', 'important');
  host.style.setProperty('font-family', '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif', 'important');
  host.style.setProperty('overflow', 'hidden', 'important');
  host.style.setProperty('pointer-events', 'auto', 'important');

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { color-scheme: light dark; }
    * { box-sizing: border-box; }
    .src {
      padding: 8px 12px 4px;
      color: ${theme.muted};
      font-size: 11px;
      line-height: 1.45;
      max-height: 72px;
      overflow: hidden;
    }
    .dst {
      padding: 0 12px 10px;
      color: ${theme.text};
      font-size: 13px;
      line-height: 1.55;
    }
    .loading {
      padding: 10px 12px;
      color: #8e8e93;
      font-size: 12px;
      animation: ot-fade 1s ease-in-out infinite alternate;
    }
    @keyframes ot-fade { from { opacity: 0.4; } to { opacity: 0.9; } }
    .pin {
      position: absolute;
      top: 4px;
      right: 6px;
      width: 24px;
      height: 24px;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: #aeaeb2;
      font-size: 13px;
      cursor: pointer;
    }
    .pin:hover { background: rgba(60,64,67,0.1); }
    .pin[data-pinned="true"] { color: #007aff; }
    @media (prefers-color-scheme: dark) {
      .src { color: #8e8e93; }
      .dst { color: #f5f5f7; }
      .loading { color: #8e8e93; }
      .pin { color: #8e8e93; }
      .pin:hover { background: rgba(255,255,255,0.1); }
    }
  `;
  const src = document.createElement('div');
  src.className = 'src';
  src.textContent = source;
  const dst = document.createElement('div');
  dst.className = 'dst';
  dst.textContent = '翻译中…';
  dst.classList.add('loading');
  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = 'pin';
  pin.textContent = '📌';
  pin.title = '固定译文';
  pin.setAttribute('aria-label', '固定译文');
  let pinned = false;
  pin.addEventListener('click', () => {
    pinned = !pinned;
    pin.dataset.pinned = String(pinned);
    pin.title = pinned ? '取消固定' : '固定译文';
    onPinnedChange(pinned);
  });
  shadow.append(style, src, dst, pin);

  return {
    host,
    setTranslation: (t) => {
      dst.textContent = t;
      dst.classList.remove('loading');
    },
    setSource: (s2) => {
      src.textContent = s2;
    },
  };
}

// ===== 输入框翻译按钮 =====
export function createInputTranslateButton(
  onClick: () => void,
): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'ot-input-btn';
  btn.textContent = '\u8BD1'; // 译
  btn.title = '翻译输入框内容';
  btn.setAttribute('aria-label', '翻译输入框内容');
  btn.style.setProperty('all', 'initial', 'important');
  btn.style.setProperty('position', 'fixed', 'important');
  btn.style.setProperty('z-index', '2147483646', 'important');
  btn.style.setProperty('width', '30px', 'important');
  btn.style.setProperty('height', '30px', 'important');
  btn.style.setProperty('border-radius', '50%', 'important');
  btn.style.setProperty('border', 'none', 'important');
  btn.style.setProperty('background', 'linear-gradient(180deg, #2b8cff 0%, #007aff 100%)', 'important');
  btn.style.setProperty('color', '#fff', 'important');
  btn.style.setProperty('font-size', '14px', 'important');
  btn.style.setProperty('font-weight', '600', 'important');
  btn.style.setProperty('display', 'flex', 'important');
  btn.style.setProperty('align-items', 'center', 'important');
  btn.style.setProperty('justify-content', 'center', 'important');
  btn.style.setProperty('cursor', 'pointer', 'important');
  btn.style.setProperty('boxShadow', '0 3px 10px rgba(0,122,255,0.35)', 'important');
  btn.style.setProperty('font-family', '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif', 'important');
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return btn;
}
