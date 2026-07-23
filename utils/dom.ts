// 以语义段落为单位抽取文本。稳定的块级锚点既能保留句子上下文，也能避免把译文
// 插进链接、图标或行内 span 后面导致页面布局断裂。
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
  'CODE', 'PRE', 'SVG', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS',
]);

const SEMANTIC_TAGS = new Set([
  'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE',
  'FIGCAPTION', 'TD', 'TH', 'DT', 'DD', 'CAPTION',
]);

const FALLBACK_TAGS = new Set(['DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'MAIN']);
const INTERACTIVE_ROLES = new Set([
  'menuitem', 'menuitemradio', 'menuitemcheckbox', 'option', 'treeitem',
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
  'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote',
  'figcaption', 'td', 'th', 'dt', 'dd', 'caption', 'div', 'section',
  'article', 'aside', 'main', INTERACTIVE_SELECTOR,
].join(',');

export const TRANSLATED_CLASS = 'ot-translated';
export const PENDING_CLASS = 'ot-pending';
export const OBSERVED_CLASS = 'ot-observed';

const OWN_SELECTOR = [
  '.ot-translation',
  '.ot-img-panel',
  '.ot-img-seg',
  '#ot-error-modal',
  '#ot-selection-ui',
  '.ot-selbtn',
  '#ot-status',
  '#ot-toolbar',
].join(',');

const PAGE_CHROME_SELECTOR = [
  '[role="banner"]',
  '[role="toolbar"]',
  '[role="search"]',
].join(',');

function isDirectPageChrome(element: Element): boolean {
  if (element.closest(PAGE_CHROME_SELECTOR)) return true;
  const header = element.closest('header');
  // 页面级页眉属于站点操作区；文章或正文内部的 header 仍应翻译。
  return Boolean(header && !header.closest('main, article'));
}

function isPageChrome(element: Element): boolean {
  if (isDirectPageChrome(element)) return true;
  const popup = element.closest('[role="menu"], [role="menubar"], [role="listbox"]');
  if (!popup) return false;

  // Portal 菜单虽然被挂到 body 末尾，仍可通过无障碍关系找到触发按钮。
  // 由站点页眉/导航触发的菜单继续排除，正文表单触发的菜单则允许翻译。
  const labelledIds = (popup.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
  if (labelledIds.some((id) => {
    const control = document.getElementById(id);
    return Boolean(control && isDirectPageChrome(control));
  })) return true;

  if (!popup.id) return false;
  return Array.from(document.querySelectorAll('[aria-controls], [aria-owns]')).some((control) => {
    const ids = `${control.getAttribute('aria-controls') || ''} ${control.getAttribute('aria-owns') || ''}`
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
    html.getAttribute('aria-hidden') === 'true'
  );
}

function isProcessed(element: Element): boolean {
  const classes = (element as HTMLElement).classList;
  return Boolean(
    classes?.contains(TRANSLATED_CLASS) ||
    classes?.contains(PENDING_CLASS) ||
    classes?.contains(OBSERVED_CLASS)
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
  const isMenuButton = element.tagName === 'BUTTON' && Boolean(element.closest('[role="menu"], [role="listbox"]'));
  return (
    SEMANTIC_TAGS.has(element.tagName) ||
    FALLBACK_TAGS.has(element.tagName) ||
    Boolean(role && INTERACTIVE_ROLES.has(role)) ||
    isMenuButton
  );
}

function isExcludedControlText(parent: Element): boolean {
  const control = parent.closest('button, [role="button"]');
  if (!control) return false;
  return !control.matches(INTERACTIVE_SELECTOR);
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
      const excluded = parent.closest(`${OWN_SELECTOR},script,style,noscript,textarea,input,select,option,code,pre,svg`);
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
      (includeProcessed || !isProcessed(current))
    ) return current;
    current = current.parentElement;
  }
  return null;
}

export function collectTextBlocks(root: Document | Element = document, limit = Infinity): Element[] {
  const candidates: Element[] = [];
  const consider = (element: Element) => {
    if (isRejected(element) || !isCandidate(element) || !isVisible(element)) return;
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

  if (root instanceof Element && !isRejected(root) && isCandidate(root) && isVisible(root)) {
    const text = textOfBlock(root);
    if (text.length >= 2) batch.push({ el: root, text });
  }

  let element: Element | null;
  while (shouldContinue() && (element = walker.nextNode() as Element | null)) {
    visited++;
    if (isCandidate(element) && isVisible(element)) {
      const text = textOfBlock(element);
      if (text.length >= 2) batch.push({ el: element, text });
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
