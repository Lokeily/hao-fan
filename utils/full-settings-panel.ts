// 页面内「完整设置」大面板：从 entrypoints/content.ts 抽出（v0.2.16 框架层整理）。
//
// content.ts 已四千余行，面板的 DOM/CSS/滚动锁/导航逻辑混在其中难以维护。
// 这里把整块收成一个模块，对外只暴露「打开 → 构建内容 → 关闭」三步：
//   - 面板外壳、样式、遮罩、Esc/空白关闭、页面滚动锁全部内聚在此；
//   - 表单内容由调用方通过 build(mount) 注入（仍共用 utils/ui.ts 的表单）；
//   - 吸顶分组导航在内容构建完成后按实际存在的分组标题生成，并带当前分组高亮。
//
// 视觉约定（本次修复的「吸顶断层」）：
//   导航必须与滚动容器同宽（负 margin 抵消 body 内边距），背景接近不透明，
//   未滚动时无分隔线、滚动后浮出分隔线 + 投影，避免内容从两侧缝隙穿透。

import { getThemeOverride, themeColors } from './content-ui.ts';
import fullSettingsCss from '../styles/options.css?raw';

export interface FullSettingsPanelOptions {
  /** 异步构建表单内容；可返回清理函数，随面板关闭调用 */
  build: (mount: HTMLElement) => Promise<{ dispose?: () => void } | void>;
  /** 面板关闭回调（调用方在此清理自己的引用） */
  onClose?: () => void;
  title?: string;
  hint?: string;
}

export interface FullSettingsPanelHandle {
  host: HTMLElement;
  close: () => void;
  isOpen: () => boolean;
}

interface NavEntry {
  button: HTMLButtonElement;
  section: HTMLElement;
}

export function openFullSettingsPanel(options: FullSettingsPanelOptions): FullSettingsPanelHandle {
  const theme = themeColors();
  // v0.2.18 主题方案：面板颜色全部走 CSS 变量（fallback = 当前主题字面量）。
  // 变量优先来自 options.css 的 :host 令牌（带 @media 深色覆盖）——面板开着时
  // 切系统深浅色能即时跟随；用户在设置里强制深/浅色时，再把字面量写死到
  // host 内联变量上覆盖 media query（applyForcedThemeVars）。
  const host = document.createElement('div');
  host.id = 'ot-full-settings';
  host.dataset.haofanUi = 'true';
  host.style.setProperty('all', 'initial', 'important');
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('inset', '0', 'important');
  host.style.setProperty('z-index', '2147483646', 'important');
  host.style.setProperty('background', 'var(--ot-scrim, rgba(0,0,0,0.45))', 'important');
  host.style.setProperty('backdrop-filter', 'blur(12px) saturate(110%)', 'important');
  host.style.setProperty('-webkit-backdrop-filter', 'blur(12px) saturate(110%)', 'important');
  host.style.setProperty('display', 'flex', 'important');
  host.style.setProperty('align-items', 'center', 'important');
  host.style.setProperty('justify-content', 'center', 'important');
  host.style.setProperty('animation', 'ot-modal-fade 0.18s ease', 'important');

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host {
      color-scheme: light dark;
      /* 面板专属的随系统切换变量：遮罩 / 吸顶导航（options.css 无这些令牌）。
         用户强制主题时由 applyForcedThemeVars 写死到 host 内联变量覆盖。 */
      --ot-scrim: rgba(0, 0, 0, 0.45);
      --ot-nav-bg: rgba(250, 250, 252, 0.94);
      --ot-nav-border: rgba(0, 0, 0, 0.08);
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --ot-scrim: rgba(0, 0, 0, 0.6);
        --ot-nav-bg: rgba(28, 28, 30, 0.94);
        --ot-nav-border: rgba(255, 255, 255, 0.10);
      }
    }
    * { box-sizing: border-box; }
    @keyframes ot-modal-fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes ot-modal-pop {
      from { opacity: 0; transform: scale(0.96) translateY(10px); }
      to { opacity: 1; transform: none; }
    }
    .modal {
      display: flex; flex-direction: column;
      width: min(640px, calc(100vw - 48px));
      max-height: min(80vh, 720px);
      border-radius: 20px;
      background: var(--surface, ${theme.surface});
      color: var(--text, ${theme.text});
      border: 1px solid var(--card-border, ${theme.border});
      box-shadow: 0 8px 24px rgba(0,0,0,0.18), 0 48px 120px rgba(0,0,0,0.45);
      overflow: hidden;
      animation: ot-modal-pop 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .head {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--card-border, ${theme.border});
      user-select: none;
    }
    .title { flex: 1; font-size: 15px; font-weight: 700; letter-spacing: 0; }
    .close {
      width: 30px; height: 30px; padding: 0;
      border: 0; border-radius: 9px;
      background: transparent; color: var(--text-2, ${theme.text2});
      font-size: 20px; line-height: 1; cursor: pointer;
    }
    .close:hover { background: rgba(128,128,128,0.18); color: var(--text, ${theme.text}); }
    .ot-full-settings-body {
      flex: 1; min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      /* 顶部不再留白：留白会让 sticky 导航上方露出一条滚动内容的缝 */
      padding: 0 20px 40px;
    }
    .foot {
      display: flex; align-items: center; justify-content: center; gap: 12px;
      padding: 10px 16px;
      border-top: 1px solid var(--card-border, ${theme.border});
    }
    .foot-hint { color: var(--text-2, ${theme.text2}); font-size: 11px; }

    /* ===== 分组快捷导航 ===== */
    /* 负 margin 抵消 body 的 20px 内边距：导航必须铺满滚动容器整宽，
       否则内容会从两侧 14px 的沟槽里穿过，看起来就是"导航断了"。 */
    .ot-settings-nav {
      position: sticky; top: 0; z-index: 3;
      display: flex; flex-wrap: nowrap; gap: 6px;
      margin: 0 -20px 14px;
      padding: 10px 20px;
      background: var(--ot-nav-bg, rgba(250, 250, 252, 0.94));
      backdrop-filter: blur(18px) saturate(160%);
      -webkit-backdrop-filter: blur(18px) saturate(160%);
      border-bottom: 1px solid transparent;
      overflow-x: auto;
      scrollbar-width: none;
      transition: border-color 0.18s ease, box-shadow 0.18s ease;
    }
    .ot-settings-nav::-webkit-scrollbar { display: none; }
    .ot-settings-nav[hidden] { display: none; }
    /* 滚动后浮出分隔线与投影：既标出"内容正在下面流过"，又不破坏顶部衔接 */
    .ot-settings-nav.is-pinned {
      border-bottom-color: var(--ot-nav-border, rgba(0, 0, 0, 0.08));
      box-shadow: 0 6px 18px -12px rgba(0, 0, 0, 0.45);
    }
    .ot-settings-nav-item {
      flex: 0 0 auto;
      padding: 5px 11px;
      border: 0; border-radius: 999px;
      background: var(--surface-2, ${theme.surface2}); color: var(--text-2, ${theme.text2});
      font-family: inherit; font-size: 12.5px; font-weight: 600;
      white-space: nowrap; cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .ot-settings-nav-item:hover {
      color: var(--text, ${theme.text});
      background: var(--accent-soft, ${theme.accentSoft});
    }
    /* 当前分组：accent 胶囊 + 主色文字，一眼知道自己在哪一层 */
    .ot-settings-nav-item.is-active {
      background: var(--accent-soft, ${theme.accentSoft});
      color: var(--accent, ${theme.accent});
    }
    .ot-settings-nav-item:focus-visible {
      outline: 2px solid var(--accent-soft, ${theme.accentSoft}); outline-offset: 1px;
    }

    /* ===== 分组层级：标题条 + 左侧 accent 竖条 ===== */
    /* options.css 里两套标题样式（h2 与 details summary）不一致，
       且分组之间只有留白，滚动时层与层分不开。这里在面板内统一并加强。 */
    .ot-form-section {
      scroll-margin-top: calc(var(--ot-nav-h, 56px) + 12px);
      margin: 18px 0;
    }
    .ot-form-section:first-of-type { margin-top: 12px; }
    .ot-form-section > h2,
    details.ot-advanced-section > summary {
      display: flex; align-items: center; gap: 8px;
      margin: 0;
      padding: 13px 16px 11px;
      border-bottom: 1px solid var(--separator, ${theme.hairline});
      background: var(--surface-2, ${theme.surface2});
      color: var(--text, ${theme.text});
      font-size: 13.5px; font-weight: 700; line-height: 1.35;
      letter-spacing: 0.2px;
    }
    .ot-form-section > h2::before {
      content: '';
      width: 3px; height: 13px; border-radius: 2px;
      background: var(--accent, ${theme.accent});
    }
    details.ot-advanced-section > summary::after {
      content: '\\25B8';
      margin-left: auto;
      color: var(--accent, ${theme.accent});
      font-size: 11px;
      transition: transform 0.15s ease;
    }
    details.ot-advanced-section[open] > summary::after { content: '\\25BE'; }
    /* details 的箭头改到 ::after（见上），原 ::before 让位给与 h2 一致的排版 */
    details.ot-advanced-section > summary::before { content: none; }
    details.ot-advanced-section > summary { list-style: none; cursor: pointer; user-select: none; }
    details.ot-advanced-section > summary::-webkit-details-marker { display: none; }
  `;

  const head = document.createElement('div');
  head.className = 'head';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = options.title || '\u597D\u7FFB \u00B7 \u5B8C\u6574\u8BBE\u7F6E'; // 好翻 · 完整设置
  // 变量名不能叫 close：与下面的 close() 清理函数重名会覆盖它。
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'close';
  closeBtn.textContent = '\u00D7'; // ×
  closeBtn.setAttribute('aria-label', '\u5173\u95ED\u5B8C\u6574\u8BBE\u7F6E');
  head.append(title, closeBtn);

  const body = document.createElement('div');
  body.className = 'ot-full-settings-body';
  const nav = document.createElement('nav');
  nav.className = 'ot-settings-nav';
  nav.setAttribute('aria-label', '\u8BBE\u7F6E\u5206\u7EC4'); // 设置分组
  nav.hidden = true;
  const mount = document.createElement('div');
  body.append(nav, mount);
  const foot = document.createElement('div');
  foot.className = 'foot';
  const hint = document.createElement('span');
  hint.className = 'foot-hint';
  hint.textContent = options.hint || '\u8BBE\u7F6E\u81EA\u52A8\u4FDD\u5B58 \u00B7 \u5FEB\u6377\u952E Alt+T \u7FFB\u8BD1\u5F53\u524D\u7F51\u9875';
  foot.appendChild(hint);
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.append(head, body, foot);
  shadow.append(style, modal);
  document.documentElement.appendChild(host);

  // options.css 必须排在面板外壳样式之前（测试断言 shadow 内首个 style 是它），
  // 面板外壳样式随后胜出——分区标题等覆盖规则依赖这个顺序。
  const sheet = document.createElement('style');
  sheet.textContent = fullSettingsCss
    .replace(/:root/g, ':host')
    .replace(/\bbody\b/g, '.ot-full-settings-body');
  shadow.prepend(sheet);

  // 用户强制深/浅色时：把该主题的字面量写死到 host 内联变量上，
  // 覆盖 options.css 的 @media 深色令牌——面板立即且稳定地呈现强制主题。
  // （themeColors() 已按 override 解析，直接取它的值即可。）
  const override = getThemeOverride();
  if (override !== 'auto') {
    const forced = themeColors();
    const setVar = (name: string, value: string) => host.style.setProperty(name, value, 'important');
    setVar('--surface', forced.surface);
    setVar('--surface-2', forced.surface2);
    setVar('--text', forced.text);
    setVar('--text-2', forced.text2);
    setVar('--card-border', forced.border);
    setVar('--separator', forced.hairline);
    setVar('--accent', forced.accent);
    setVar('--accent-soft', forced.accentSoft);
    const darkForced = override === 'dark';
    setVar('--ot-scrim', darkForced ? 'rgba(0, 0, 0, 0.6)' : 'rgba(0, 0, 0, 0.45)');
    setVar(
      '--ot-nav-bg',
      darkForced ? 'rgba(28, 28, 30, 0.94)' : 'rgba(250, 250, 252, 0.94)',
    );
    setVar(
      '--ot-nav-border',
      darkForced ? 'rgba(255, 255, 255, 0.10)' : 'rgba(0, 0, 0, 0.08)',
    );
  }

  let cleaned = false;
  let buildDispose: (() => void) | null = null;
  let navResizeObserver: ResizeObserver | null = null;
  let activeFrame: number | null = null;
  const entries: NavEntry[] = [];

  function close(): void {
    if (cleaned) return;
    cleaned = true;
    document.removeEventListener('keydown', escHandler, true);
    window.removeEventListener('wheel', wheelLock, true);
    window.removeEventListener('touchmove', touchLock, true);
    body.removeEventListener('scroll', onScroll);
    if (activeFrame !== null) cancelAnimationFrame(activeFrame);
    navResizeObserver?.disconnect();
    navResizeObserver = null;
    try {
      buildDispose?.();
    } catch {
      /* 清理失败也要把面板移除 */
    }
    buildDispose = null;
    host.remove();
    options.onClose?.();
  }

  closeBtn.addEventListener('click', close);
  // 不能用 e.target === host：Shadow DOM 会把内部点击目标重定向为 host，
  // 用 composedPath() 才能拿到真实目标，避免"点输入框就关闭面板"。
  host.addEventListener('pointerdown', (e) => {
    if (e.composedPath()[0] === host) close();
  });
  function escHandler(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', escHandler, true);

  // 面板打开期间锁住页面滚动：落在遮罩上的滚轮/触摸才阻止，面板内照常滚动。
  const inModal = (e: Event) => (e.composedPath() as EventTarget[]).includes(modal);
  function wheelLock(e: WheelEvent): void {
    if (!inModal(e)) e.preventDefault();
  }
  function touchLock(e: TouchEvent): void {
    if (!inModal(e)) e.preventDefault();
  }
  window.addEventListener('wheel', wheelLock, true);
  window.addEventListener('touchmove', touchLock, true);

  // 导航高度 → CSS 变量：跳转时的 scroll-margin 跟着实际高度走，
  // 不再硬编码 60px（窄屏换行/字号变化会让标题被吸顶导航压住）。
  function syncNavHeight(): void {
    const height = nav.offsetHeight || 56;
    body.style.setProperty('--ot-nav-h', `${height}px`);
  }

  function syncActive(): void {
    if (entries.length === 0) return;
    const navRect = nav.getBoundingClientRect();
    // 判定线在导航底缘下方 8px，再留 28px 容差：分组间距 18px + 标题条
    // 本身的高度，意味着上一组完全滚出视口后、下一组标题还要走 ~26px 才
    // 越过贴线判定——容差太小会高亮滞后一格（实测滚动 900px 时差 18px）。
    const line = navRect.bottom + 8;
    let index = 0;
    for (let i = 0; i < entries.length; i++) {
      const rect = entries[i].section.getBoundingClientRect();
      if (rect.top - line <= 28) index = i;
    }
    // 滚到底部时最后一节可能还够不到判定线，直接高亮最后一项
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 4) index = entries.length - 1;
    entries.forEach((entry, i) => {
      const active = i === index;
      entry.button.classList.toggle('is-active', active);
      if (active) entry.button.setAttribute('aria-current', 'true');
      else entry.button.removeAttribute('aria-current');
    });
    // 横向：让当前胶囊保持可见（只动导航自身，不影响纵向滚动）
    const activeButton = entries[index]?.button;
    if (activeButton) {
      const left = activeButton.offsetLeft;
      const right = left + activeButton.offsetWidth;
      if (left < nav.scrollLeft) nav.scrollLeft = Math.max(0, left - 12);
      else if (right > nav.scrollLeft + nav.clientWidth) {
        nav.scrollLeft = right - nav.clientWidth + 12;
      }
    }
  }

  function onScroll(): void {
    nav.classList.toggle('is-pinned', body.scrollTop > 2);
    if (activeFrame !== null) return;
    activeFrame = requestAnimationFrame(() => {
      activeFrame = null;
      syncActive();
    });
  }
  body.addEventListener('scroll', onScroll, { passive: true });

  function buildSettingsNav(): void {
    nav.replaceChildren();
    entries.length = 0;
    const sections = Array.from(mount.querySelectorAll<HTMLElement>('.ot-form-section'));
    for (const section of sections) {
      const label = section.querySelector('h2, summary')?.textContent?.trim();
      if (!label) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ot-settings-nav-item';
      button.textContent = label;
      button.addEventListener('click', () => {
        section.scrollIntoView({ block: 'start', behavior: 'smooth' });
        entries.forEach((entry) => entry.button.classList.remove('is-active'));
        button.classList.add('is-active');
        button.setAttribute('aria-current', 'true');
      });
      nav.appendChild(button);
      entries.push({ button, section });
    }
    nav.hidden = nav.childElementCount === 0;
    syncNavHeight();
    syncActive();
  }

  void (async () => {
    try {
      const result = await options.build(mount);
      if (cleaned) {
        // 构建期间面板已关闭：立刻清理刚建好的表单监听，不留孤儿。
        result?.dispose?.();
        return;
      }
      buildDispose = result?.dispose ?? null;
      buildSettingsNav();
      if (typeof ResizeObserver !== 'undefined') {
        navResizeObserver = new ResizeObserver(() => {
          syncNavHeight();
          syncActive();
        });
        navResizeObserver.observe(nav);
      }
    } catch {
      if (cleaned) return;
      mount.textContent = '\u8BBE\u7F6E\u52A0\u8F7D\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00'; // 设置加载失败，请重新打开
      mount.style.cssText = 'padding:12px;font-size:13px;color:#ff3b30;';
    }
  })();

  return { host, close, isOpen: () => !cleaned };
}
