// 内容脚本的纯 UI 构建辅助（从 entrypoints/content.ts 拆分）。
// 只负责「用原生 DOM 构造隔离良好的界面元素」，不持有页面翻译状态，
// 因此可独立维护与测试。

// ===== 译文嵌入节点 =====
// 直接在原文文字下方插入译文节点，形成原文与译文的对照显示，嵌入文档流
// 随页面滚动/缩放自然跟随，不产生叠加层遮挡。
// 用 <span> + display:block（而非 <div>）渲染，避免 <div> 被塞进 <p>/<li>/<a>
// 等不可含块级元素的容器时浏览器自动闭合父节点，导致译文错位/堆叠。
export function createTranslationNode(translation: string, anchor: Element): HTMLSpanElement {
  const host = document.createElement('span');
  host.className = 'ot-translation';
  host.dataset.haofanTranslation = 'true';
  host.setAttribute('role', 'note');
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
      opacity: 0.78;
      text-decoration: none;
      text-indent: 0;
      direction: auto;
      overflow-wrap: anywhere;
      white-space: normal;
    }
  `;
  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = translation;
  shadow.append(style, text);
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
      background: rgba(0, 0, 0, 0.48);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .dialog {
      box-sizing: border-box;
      width: min(420px, 100%);
      padding: 22px;
      border: 1px solid #dadce0;
      border-radius: 8px;
      background: #fff;
      color: #202124;
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.28);
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
      background: #1a73e8;
      color: #fff;
      font: 600 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      letter-spacing: 0;
      cursor: pointer;
    }
    button:hover { background: #1765cc; }
    button:focus-visible { outline: 3px solid rgba(26, 115, 232, 0.35); outline-offset: 2px; }
    @media (prefers-color-scheme: dark) {
      .dialog { border-color: #30363d; background: #161b22; color: #f0f6fc; }
      p { color: #b1bac4; }
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
      display: grid; place-items: center; background: #1a73e8; color: #fff;
      box-shadow: 0 4px 14px rgba(0, 0, 0, .25); cursor: pointer;
      font: 650 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
    }
    .trigger:hover { background: #1765cc; }
    .trigger:focus-visible, .action:focus-visible, .close:focus-visible {
      outline: 3px solid rgba(26, 115, 232, .35); outline-offset: 2px;
    }
    .panel {
      width: min(360px, calc(100vw - 16px)); max-height: min(360px, calc(100vh - 16px));
      overflow: auto; border: 1px solid #dadce0; border-radius: 8px;
      background: #fff; color: #202124; box-shadow: 0 12px 34px rgba(0, 0, 0, .25);
      font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
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
