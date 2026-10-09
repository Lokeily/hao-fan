// 以语义段落为单位抽取文本。稳定的块级锚点既能保留句子上下文，也能避免把译文
// 插进链接、图标或行内 span 后面导致页面布局断裂。
const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'OPTION',
  'CODE',
  'PRE',
  'SVG',
  'IMG',
  'VIDEO',
  'AUDIO',
  'CANVAS',
]);

const SEMANTIC_TAGS = new Set([
  'P',
  'LI',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'FIGCAPTION',
  'TD',
  'TH',
  'DT',
  'DD',
  'CAPTION',
]);

const FALLBACK_TAGS = new Set(['DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'MAIN']);
// 纯语义块选择器（不含 DIV 等兜底容器）：用于区分「正文里的链接」与「独立 CTA 链接」
const SEMANTIC_BLOCK_SELECTOR = Array.from(SEMANTIC_TAGS)
  .map((tag) => tag.toLowerCase())
  .join(',');
const INTERACTIVE_ROLES = new Set([
  'menuitem',
  'menuitemradio',
  'menuitemcheckbox',
  'option',
  'treeitem',
]);
const INTERACTIVE_SELECTOR = [
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="option"]',
  '[role="treeitem"]',
  '[role="menu"] button',
  '[role="listbox"] button',
].join(',');
const CANDIDATE_SELECTOR = [
  'p',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'figcaption',
  'td',
  'th',
  'dt',
  'dd',
  'caption',
  'div',
  'section',
  'article',
  'aside',
  'main',
  INTERACTIVE_SELECTOR,
].join(',');

export const TRANSLATED_CLASS = 'ot-translated';
export const PENDING_CLASS = 'ot-pending';
export const OBSERVED_CLASS = 'ot-observed';

// 自有 UI 表面统一清单：点击 / 悬停 / 划词 / 扫描 / 文本收集等所有路径共用，
// 确保扩展自身的浮层永远不会被当成网页内容处理（此前漏掉 #ot-full-settings
// 导致手动模式下点击设置面板会反复弹出无 Key 引导弹窗的恶性 bug）。
const OWN_SELECTOR = [
  '.ot-translation',
  '.ot-img-panel',
  '.ot-img-seg',
  '.ot-img-canvas',
  '#ot-error-modal',
  '#ot-selection-ui',
  '#ot-full-settings',
  '#ot-settings-panel',
  '#ot-hover-bubble',
  '#ot-input-btn',
  '#ot-input-result',
  '.ot-selbtn',
  '#ot-status',
  '#ot-toolbar',
  '.ot-fail-card',
].join(',');

/** 与 OWN_SELECTOR 相同，供内容脚本等外部模块引用，避免各自维护不一致的名单 */
export const UI_SURFACE_SELECTOR = OWN_SELECTOR;

const PAGE_CHROME_SELECTOR = ['[role="banner"]', '[role="toolbar"]', '[role="search"]'].join(',');

// 站点显式声明「不要翻译」的事实标准标记（Google 翻译时代沿用至今）：
// translate="no" 属性与 notranslate 类。遵守它们可以避免误译品牌名、
// 代码串、刻意保留原文的营销文案（v0.2.14）。
const NO_TRANSLATE_SELECTOR = '[translate="no"], .notranslate';

function isDirectPageChrome(element: Element): boolean {
  if (element.closest(PAGE_CHROME_SELECTOR)) return true;
  const header = element.closest('header');
  // 页面级页眉属于站点操作区；文章或正文内部的 header 仍应翻译。
  if (header && !header.closest('main, article')) return true;
  // 页面顶层的主导航同理：<nav id="globalnav"> 这类站点导航整条翻译会出现
  // 半中半英的导航栏（Apple 官网实测），且搜索框、购物袋按钮都会被误翻。
  // 只跳「页面顶层」的 nav——放在内容容器（main/article/aside/section/footer）里的
  // nav 属于页面内容的一部分（如 GitHub 仓库侧栏导航、文章目录），仍应翻译。
  const nav = element.closest('nav');
  if (
    nav &&
    !nav.closest('main, article, aside, section, footer, [role="main"], [role="complementary"]')
  ) {
    return true;
  }
  return false;
}

function isPageChrome(element: Element): boolean {
  if (isDirectPageChrome(element)) return true;
  const popup = element.closest('[role="menu"], [role="menubar"], [role="listbox"]');
  if (!popup) return false;

  // Portal 菜单虽然被挂到 body 末尾，仍可通过无障碍关系找到触发按钮。
  // 由站点页眉/导航触发的菜单继续排除，正文表单触发的菜单则允许翻译。
  const labelledIds = (popup.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
  if (
    labelledIds.some((id) => {
      const control = document.getElementById(id);
      return Boolean(control && isDirectPageChrome(control));
    })
  )
    return true;

  if (!popup.id) return false;
  return Array.from(document.querySelectorAll('[aria-controls], [aria-owns]')).some((control) => {
    const ids =
      `${control.getAttribute('aria-controls') || ''} ${control.getAttribute('aria-owns') || ''}`
        .split(/\s+/)
        .filter(Boolean);
    return ids.includes(popup.id) && isDirectPageChrome(control);
  });
}

function rejectsSubtree(element: Element): boolean {
  const html = element as HTMLElement;
  return (
    SKIP_TAGS.has(element.tagName) ||
    isPageChrome(element) ||
    html.matches?.(OWN_SELECTOR) ||
    html.isContentEditable ||
    html.getAttribute('aria-hidden') === 'true' ||
    Boolean(html.closest?.(NO_TRANSLATE_SELECTOR))
  );
}

function isProcessed(element: Element): boolean {
  const classes = (element as HTMLElement).classList;
  return Boolean(
    classes?.contains(TRANSLATED_CLASS) ||
    classes?.contains(PENDING_CLASS) ||
    classes?.contains(OBSERVED_CLASS),
  );
}

function isRejected(element: Element): boolean {
  return rejectsSubtree(element) || isProcessed(element);
}

function walkerDecision(element: Element): number {
  if (rejectsSubtree(element)) return NodeFilter.FILTER_REJECT;
  // 已处理的语义块只跳过自身，仍继续遍历后代，确保后续插入/显示的内容可被发现。
  if (isProcessed(element)) return NodeFilter.FILTER_SKIP;
  return NodeFilter.FILTER_ACCEPT;
}

function isCandidate(element: Element): boolean {
  const role = element.getAttribute('role');
  const isMenuButton =
    element.tagName === 'BUTTON' && Boolean(element.closest('[role="menu"], [role="listbox"]'));
  return (
    SEMANTIC_TAGS.has(element.tagName) ||
    FALLBACK_TAGS.has(element.tagName) ||
    Boolean(role && INTERACTIVE_ROLES.has(role)) ||
    isMenuButton
  );
}

function isExcludedControlText(parent: Element): boolean {
  // 文本所在的最近语义块若不被任何控件（button / CTA 链接）包含 → 这是正文
  //（含正文里的链接），照常翻译。此分支必须最先判断：Apple 官网的卡片是
  // <a class="tile"><h2>…</h2><p>…</p></a> 整块链接结构，标题/段落都在
  // <a> 内部——按旧逻辑 anchor.closest(SEMANTIC_BLOCK_SELECTOR) 向上找不到
  // 语义块，整张卡片的文字会被当 CTA 全部漏译（v0.2.14 修复）。
  const semantic = parent.closest(SEMANTIC_BLOCK_SELECTOR);
  if (semantic && !semantic.closest('button, [role="button"]')) return false;
  // 走到这里只剩两种情况：纯控件文案（无语义块包裹），或语义块本身被塞在
  // <button> 内部（罕见，译文进按钮会撑变形，继续按控件排除）。
  const control = parent.closest('button, [role="button"]');
  if (control && !control.matches(INTERACTIVE_SELECTOR)) return true;
  // 独立作为 CTA 的链接（不在任何语义段落里）视为按钮：Apple 官网的
  // <a class="button"> 全是这种结构，译文一旦进按钮会把它撑成正圆。
  // 正文段落（p/li/h*/td…）里的链接属于文本内容，照常翻译。
  const anchor = parent.closest('a');
  if (anchor && !anchor.closest(SEMANTIC_BLOCK_SELECTOR)) return true;
  return false;
}

// 按钮/链接是「原子」视觉元素：多数站点的按钮其实是 <a>（Apple 官网 35 个
// <a class="button">），它们的胶囊圆角在内容被撑高后会渲染成正圆。
export function isInteractiveControl(el: Element): boolean {
  return el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button';
}

// 容器的可见文本全部来自交互控件（按钮/链接）→ 这是 UI 控件而非正文。
// 翻译它会把译文塞进 flex/grid 布局：Apple 官网的 .tile-ctas（两个
// <a class="button">）被追加译文后按钮被挤成圆形，整页视觉崩坏（v0.2.5 实测）。
// 语义块（p/li/h*…）里的链接是正文的一部分，不受此规则影响，照常翻译。
function isControlOnlyContainer(element: Element): boolean {
  if (SEMANTIC_TAGS.has(element.tagName)) return false;
  const children = Array.from(element.children);
  if (children.length === 0) return false;
  const controls = children.filter(isInteractiveControl);
  if (controls.length !== children.length) return false;
  const controlText = controls
    .map((c) => textOfBlock(c))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!controlText) return false;
  return controlText === textOfBlock(element);
}

export function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
}

export function textOfBlock(element: Element): string {
  const parts: string[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      if (isPageChrome(parent)) return NodeFilter.FILTER_REJECT;
      const excluded = parent.closest(
        `${OWN_SELECTOR},${NO_TRANSLATE_SELECTOR},script,style,noscript,textarea,input,select,option,code,pre,svg`,
      );
      if (excluded || isExcludedControlText(parent)) return NodeFilter.FILTER_REJECT;
      const nearestBlock = parent.closest(CANDIDATE_SELECTOR);
      if (nearestBlock && nearestBlock !== element && element.contains(nearestBlock)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node: Node | null;
  while ((node = walker.nextNode())) parts.push(node.textContent || '');
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function closestTextBlock(element: Element, includeProcessed = false): Element | null {
  let current: Element | null = element;
  while (current && current !== document.documentElement) {
    if (
      isCandidate(current) &&
      !rejectsSubtree(current) &&
      !isControlOnlyContainer(current) &&
      (includeProcessed || !isProcessed(current))
    )
      return current;
    current = current.parentElement;
  }
  return null;
}

// 长纯文本块拆分：页面缺少语义块（如手写 HTML / 邮件排版：div 内多个 span 行，
// 无 <p>/<li> 等）时，整块文本会被并成一段译文堆在容器末尾，无法对应原文。
// 拆成「行级单元」独立翻译，译文与原文逐行对应。
const PLAIN_BLOCK_SPLIT_CHARS = 120;

function splitPlainBlockUnits(element: Element): Element[] | null {
  // 直接子元素中存在语义块时，页面本身已有结构，交给现有语义块逻辑处理。
  const hasSemanticChild = Array.from(element.children).some((child) => isCandidate(child));
  if (hasSemanticChild) return null;
  if (textOfBlock(element).length < PLAIN_BLOCK_SPLIT_CHARS) return null;
  const units: Element[] = [];
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const c = child as Element;
    if (c.tagName === 'BR') continue; // br 是行分隔符，不作为锚点
    const t = textOfBlock(c);
    if (t.length >= 2) units.push(c);
  }
  if (units.length < 2) return null;
  // 拆分有效性校验：行单元文本合计应覆盖父块的大部分文本（v0.2.14）。
  // 两类情况会覆盖不足：子行是被排除的控件文案（一排链接按钮，拆出来全是
  // 空单元），或父块下有未包行内元素的裸文本节点（拆分会把这段文本丢掉）。
  // 覆盖率过低时回退为整块处理，宁可少拆也不漏译。
  const unitsLength = units.reduce((sum, unit) => sum + textOfBlock(unit).length, 0);
  const parentLength = textOfBlock(element).length;
  if (parentLength > 0 && unitsLength / parentLength < 0.6) return null;
  // 注意：不能给单元加任何已处理标记——收集逻辑的 isRejected 会把标记元素当
  // 已处理跳过，导致拆出的行单元全部落空。拆分单元必然是非语义行内元素
  // （否则 hasSemanticChild 为 true 不会拆分），TreeWalker 不会单独访问它们。
  return units;
}

export function collectTextBlocks(
  root: Document | Element = document,
  limit = Infinity,
): Element[] {
  const candidates: Element[] = [];
  const consider = (element: Element) => {
    if (isRejected(element) || !isCandidate(element) || !isVisible(element)) return;
    if (isControlOnlyContainer(element)) return;
    const units = splitPlainBlockUnits(element);
    if (units) {
      for (const unit of units) {
        if (isRejected(unit) || !isVisible(unit)) continue;
        const t = textOfBlock(unit);
        if (t.length >= 2) candidates.push(unit);
      }
      return;
    }
    const text = textOfBlock(element);
    if (text.length >= 2) candidates.push(element);
  };

  if (root instanceof Element) consider(root);
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      return walkerDecision(node as Element);
    },
  });
  let element: Element | null;
  while ((element = walker.nextNode() as Element | null)) {
    consider(element);
    if (candidates.length >= limit) break;
  }
  return candidates;
}

export interface IncrementalScanOptions {
  batchSize?: number;
  nodeBudget?: number;
  shouldContinue?: () => boolean;
}

export interface ScannedTextBlock {
  el: Element;
  text: string;
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// 长页面按小批次扫描，避免一次 TreeWalker + 样式计算长时间占用主线程。
// 每发现一批就立即交给调用方，因此首屏翻译无需等待整页扫描完成。
export async function scanTextBlocksIncrementally(
  root: Document | Element,
  onBatch: (items: ScannedTextBlock[]) => void,
  options: IncrementalScanOptions = {},
): Promise<number> {
  const batchSize = Math.max(1, options.batchSize ?? 12);
  const nodeBudget = Math.max(batchSize, options.nodeBudget ?? 240);
  const shouldContinue = options.shouldContinue ?? (() => true);
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      return walkerDecision(node as Element);
    },
  });
  let batch: ScannedTextBlock[] = [];
  let visited = 0;
  let found = 0;

  const emit = () => {
    if (batch.length === 0) return;
    found += batch.length;
    onBatch(batch);
    batch = [];
  };

  const pushUnit = (el: Element) => {
    if (isRejected(el) || !isVisible(el)) return;
    const text = textOfBlock(el);
    if (text.length >= 2) batch.push({ el, text });
  };

  if (root instanceof Element && !isRejected(root) && isCandidate(root) && isVisible(root)) {
    const units = splitPlainBlockUnits(root);
    if (units) {
      units.forEach(pushUnit);
    } else {
      pushUnit(root);
    }
  }

  let element: Element | null;
  while (shouldContinue() && (element = walker.nextNode() as Element | null)) {
    visited++;
    if (isCandidate(element) && isVisible(element)) {
      const units = splitPlainBlockUnits(element);
      if (units) {
        units.forEach(pushUnit);
      } else {
        pushUnit(element);
      }
    }
    if (batch.length >= batchSize || visited >= nodeBudget) {
      emit();
      visited = 0;
      await yieldToMainThread();
    }
  }
  emit();
  return found;
}

export function markTranslated(el: Element) {
  const classes = (el as HTMLElement).classList;
  classes?.remove(PENDING_CLASS);
  classes?.add(TRANSLATED_CLASS);
}
