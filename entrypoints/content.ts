import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import {
  collectTextBlocks,
  scanTextBlocksIncrementally,
  markTranslated,
  textOfBlock,
  TRANSLATED_CLASS,
  PENDING_CLASS,
  OBSERVED_CLASS,
  isVisible,
  closestTextBlock,
} from '../utils/dom';
import { planTextChunks, takeFirstTextChunk } from '../utils/chunking';
import { configItem } from '../utils/storage';
import { isRetryableTranslationError, NoticeCycleGate } from '../utils/notice-policy';
import { SessionTranslationCache } from '../utils/session-translation-cache';
import { randomId } from '../utils/id';
import '../styles/content.css';

let activeImageCleanup: (() => void) | null = null;

// 分块大小与并发度：把整页拆成小块并发翻译，首块返回即可先渲染页面顶部，大幅压缩"首字延迟"。
const FIRST_CHUNK_ITEMS = 10;
const FIRST_CHUNK_CHARACTERS = 2_800;
const PAGE_CHUNK_ITEMS = 24;
const PAGE_CHUNK_CHARACTERS = 7_000;
const DYNAMIC_CHUNK_ITEMS = 18;
const DYNAMIC_CHUNK_CHARACTERS = 5_000;
const LAZY_CONCURRENCY = 2;
const MAX_TRANSLATION_RETRIES = 2;

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    const runtimeCandidate = (browser as any)?.runtime as typeof browser.runtime | undefined;
    // 扩展刚被更新/重载时，旧页面的内容脚本可能仍存在，但运行时桥接已经失效。
    // 此时不继续挂载 UI，等待用户刷新页面后由新扩展上下文重新注入。
    if (!runtimeCandidate?.sendMessage || !runtimeCandidate.onMessage) return;
    const runtime = runtimeCandidate;

    // 防止重复注入：右键"翻译本页"/弹窗"翻译当前网页"会通过 executeScript 再次注入本脚本，
    // 若不加守卫，消息监听 / 划词 / 点击监听 / MutationObserver 会被重复注册。
    if ((window as any).__haofanInjected) return;
    (window as any).__haofanInjected = true;

    let busy = false;
    let translatedCount = 0; // 已插入译文计数（避免每次 querySelectorAll 全文档统计，省性能）
    let estimatedTokensSaved = 0;
    let dynamicActive = false;
    let dynamicObserver: MutationObserver | null = null;
    let dynamicClickTimer: ReturnType<typeof setTimeout> | null = null;
    let dynamicQueueTimer: ReturnType<typeof setTimeout> | null = null;
    const dynamicRoots = new Set<Element>();
    let dynamicClickHandler: ((event: Event) => void) | null = null;
    let activePageJobId: string | null = null;
    type TranslationItem = { el: Element; text: string };
    let viewportObserver: IntersectionObserver | null = null;
    let lazyPending = new Map<Element, TranslationItem>();
    let lazyFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let lazyFlushRunning = false;
    let translationNodes = new WeakMap<Element, HTMLSpanElement>();
    let retryCounts = new WeakMap<Element, number>();
    const sessionTranslations = new SessionTranslationCache();
    let translationConfigRevision = 0;
    let noticeHost: HTMLElement | null = null;
    const noticeCycles = new NoticeCycleGate();
    let blockedPageJobId: string | null = null;

    // 页面内的开关/弹层反复创建相同 DOM 时直接复用译文；配置变化后立即失效，
    // 避免把旧语言或旧模型的结果继续显示出来。
    try {
      configItem.watch(() => {
        translationConfigRevision++;
        sessionTranslations.clear();
      });
    } catch {
      /* 极少数页面中 storage 监听不可用时，仅保留当前页面会话缓存。 */
    }

    async function sendRuntimeMessage(message: unknown): Promise<any> {
      try {
        return await runtime.sendMessage(message);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (/context invalidated|extension context|runtime.*undefined/i.test(detail)) {
          throw new Error('扩展已更新，请刷新当前网页后重试');
        }
        throw error;
      }
    }

    function noticeTitle(message: string): string {
      if (/API Key|未配置|设置页/.test(message)) return '需要完成设置';
      if (/扩展已更新|刷新当前网页/.test(message)) return '请刷新网页';
      return '翻译未完成';
    }

    function closeNotice() {
      noticeHost?.remove();
      noticeHost = null;
    }

    function showNotice(message: string, cycleId: string, title = noticeTitle(message)) {
      // 同一次用户操作中的并发批次只展示一次；关闭后也不会被后续失败批次再次打扰。
      if (!noticeCycles.shouldShow(cycleId)) return;
      closeNotice();

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
      acknowledge.addEventListener('click', closeNotice);
      actions.appendChild(acknowledge);
      dialog.append(heading, body, actions);
      backdrop.appendChild(dialog);
      shadow.append(style, backdrop);
      noticeHost = host;
      document.documentElement.appendChild(host);
      acknowledge.focus({ preventScroll: true });
    }
    // ===== 译文嵌入（网页嵌入对照方案）：直接在原文文字下方插入译文节点 =====
    // 形成原文与译文的对照显示，嵌入文档流随页面滚动/缩放自然跟随，不产生叠加层遮挡。
    // 用 <span> + display:block（而非 <div>）渲染，避免 <div> 被塞进 <p>/<li>/<a> 等
    // 不可含块级元素的容器时浏览器自动闭合父节点，导致译文错位/堆叠（即"显示错乱"）。
    function makeTranslationNode(translation: string, anchor: Element): HTMLSpanElement {
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

    function insertTranslation(el: Element, translation: string) {
      const existing = translationNodes.get(el);
      if (existing?.isConnected) {
        const text = existing.shadowRoot?.querySelector('.text');
        if (text) text.textContent = translation;
        return;
      }
      const node = makeTranslationNode(translation, el);
      translationNodes.set(el, node);
      const tag = el.tagName;
      const role = el.getAttribute('role');
      if (
        tag === 'BUTTON' ||
        role === 'menuitem' ||
        role === 'menuitemradio' ||
        role === 'menuitemcheckbox' ||
        role === 'option' ||
        role === 'treeitem'
      ) {
        // 交互选项通常属于会被整体隐藏/移除的浮层，译文必须留在选项内部，
        // 才能随其开关且不会掉到 Portal 外面。
        el.appendChild(node);
        return;
      }
      if (tag === 'TD' || tag === 'TH' || tag === 'DT' || tag === 'DD' || tag === 'CAPTION') {
        el.appendChild(node);
        return;
      }
      if (tag === 'LI') {
        const nestedList = Array.from(el.children).find((child) => child.tagName === 'UL' || child.tagName === 'OL');
        el.insertBefore(node, nestedList || null);
        return;
      }
      // 普通流中紧邻原文插入，多个段落即使共用 overflow:hidden 卡片也不会被搬出或倒序。
      // Flex/Grid 的直接子项不能新增兄弟项，否则会改变轨道布局，此时嵌入原语义块末尾。
      const parentDisplay = el.parentElement ? getComputedStyle(el.parentElement).display : '';
      const parentCreatesLayout =
        parentDisplay === 'flex' || parentDisplay === 'inline-flex' ||
        parentDisplay === 'grid' || parentDisplay === 'inline-grid';
      if (parentCreatesLayout) el.appendChild(node);
      else el.insertAdjacentElement('afterend', node);
    }

    function applyTranslation(el: Element, original: string, translation: string): 'inserted' | 'skipped' | 'stale' {
      if (!el.isConnected || textOfBlock(el) !== original) return 'stale';
      if (!translation || translation === original) {
        markTranslated(el);
        return 'skipped';
      }
      insertTranslation(el, translation);
      markTranslated(el);
      return 'inserted';
    }

    function restoreSessionTranslation(item: TranslationItem): boolean {
      const cached = sessionTranslations.get(item.text);
      if (cached === undefined) return false;
      const html = item.el as HTMLElement;
      viewportObserver?.unobserve(item.el);
      lazyPending.delete(item.el);
      html.classList.remove(OBSERVED_CLASS, PENDING_CLASS);
      const outcome = applyTranslation(item.el, item.text, cached);
      if (outcome === 'inserted') translatedCount++;
      return outcome !== 'stale';
    }

    // 状态提示（"翻译中…" / "已翻译 N 段"），紧贴悬浮按钮上方
    let statusEl: HTMLElement | null = null;
    let statusTimer: ReturnType<typeof setTimeout> | null = null;
    function showStatus(text: string, transient = false) {
      if (!statusEl) {
        statusEl = document.createElement('div');
        statusEl.id = 'ot-status';
        statusEl.setAttribute('role', 'status');
        statusEl.setAttribute('aria-live', 'polite');
        Object.assign(statusEl.style, {
          position: 'fixed',
          right: '20px',
          bottom: '74px',
          zIndex: '2147483646',
          background: 'rgba(28,28,30,0.86)',
          color: '#fff',
          font: '12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          padding: '6px 11px',
          borderRadius: '8px',
          pointerEvents: 'none',
          boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
          opacity: '0',
          transition: 'opacity 0.2s ease',
          maxWidth: '240px',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        });
        document.documentElement.appendChild(statusEl);
      }
      statusEl.textContent = text;
      statusEl.style.opacity = '1';
      if (statusTimer) clearTimeout(statusTimer);
      if (transient) {
        statusTimer = setTimeout(() => {
          if (statusEl) statusEl.style.opacity = '0';
        }, 2000);
      }
    }
    function hideStatus() {
      if (statusEl) statusEl.style.opacity = '0';
    }

    // ===== 翻译清理：移除所有已插入的译文节点 + 清除标记 =====
    // 这是解决"多次点击导致译文堆叠"的核心：每次整页翻译前先彻底清理上一次的残留。
    function clearTranslations() {
      stopDynamic();
      stopLazyTranslation();
      if (activePageJobId) {
        sendRuntimeMessage({
          type: 'CANCEL_TRANSLATION',
          payload: { jobId: activePageJobId },
        }).catch(() => {});
        activePageJobId = null;
      }
      // 移除所有译文节点（核心：防止多次点击叠加）
      document.querySelectorAll('.ot-translation').forEach((el) => el.remove());
      // 清除所有已翻译标记（让 collectTextBlocks 可重新收集）
      document.querySelectorAll(`.${TRANSLATED_CLASS}`).forEach((el) =>
        (el as HTMLElement).classList.remove(TRANSLATED_CLASS),
      );
      // 清除排队中标记
      document.querySelectorAll(`.${PENDING_CLASS}`).forEach((el) =>
        (el as HTMLElement).classList.remove(PENDING_CLASS),
      );
      document.querySelectorAll(`.${OBSERVED_CLASS}`).forEach((el) =>
        (el as HTMLElement).classList.remove(OBSERVED_CLASS),
      );
      translationNodes = new WeakMap<Element, HTMLSpanElement>();
      retryCounts = new WeakMap<Element, number>();
      blockedPageJobId = null;
      // 移除图片翻译层，并释放其滚动/缩放监听。
      activeImageCleanup?.();
      activeImageCleanup = null;
      document.querySelectorAll('.ot-img-panel, .ot-img-seg').forEach((el) => el.remove());
      translatedCount = 0;
      estimatedTokensSaved = 0;
      hideStatus();
    }

    // ===== 并发分块执行 =====
    async function runChunkQueue<T>(
      chunks: T[][],
      concurrency: number,
      fn: (chunk: T[]) => Promise<void>,
    ): Promise<number> {
      let idx = 0;
      let failures = 0;
      const worker = async () => {
        while (idx < chunks.length) {
          const chunk = chunks[idx++];
          try {
            await fn(chunk);
          } catch {
            failures++;
          }
        }
      };
      const n = Math.min(concurrency, Math.max(1, chunks.length));
      await Promise.all(Array.from({ length: n }, () => worker()));
      return failures;
    }

    function isInViewport(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      return rect.bottom >= 0 && rect.top <= window.innerHeight;
    }

    function scheduleLazyFlush(delay = 120) {
      if (lazyFlushTimer) clearTimeout(lazyFlushTimer);
      lazyFlushTimer = setTimeout(() => {
        lazyFlushTimer = null;
        void flushLazyQueue();
      }, delay);
    }

    function enqueueLazyItem(element: Element): boolean {
      const html = element as HTMLElement;
      if (
        !element.isConnected ||
        html.classList.contains(TRANSLATED_CLASS) ||
        html.classList.contains(PENDING_CLASS)
      ) {
        viewportObserver?.unobserve(element);
        html.classList.remove(OBSERVED_CLASS);
        return false;
      }
      const text = textOfBlock(element);
      if (text.length < 2 || !isVisible(element)) return false;
      if (restoreSessionTranslation({ el: element, text })) return false;
      viewportObserver?.unobserve(element);
      html.classList.remove(OBSERVED_CLASS);
      html.classList.add(PENDING_CLASS);
      lazyPending.set(element, { el: element, text });
      return true;
    }

    function ensureViewportObserver(): IntersectionObserver {
      if (viewportObserver) return viewportObserver;
      viewportObserver = new IntersectionObserver((entries) => {
        let queued = false;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (enqueueLazyItem(entry.target)) queued = true;
        }
        if (queued) scheduleLazyFlush();
      }, {
        root: null,
        rootMargin: '320px 0px',
        threshold: 0,
      });
      return viewportObserver;
    }

    function observeForLazyTranslation(items: TranslationItem[]): number {
      const observer = ensureViewportObserver();
      let observed = 0;
      for (const item of items) {
        const html = item.el as HTMLElement;
        if (
          !item.el.isConnected ||
          html.classList.contains(TRANSLATED_CLASS) ||
          html.classList.contains(PENDING_CLASS) ||
          html.classList.contains(OBSERVED_CLASS)
        ) continue;
        if (restoreSessionTranslation(item)) continue;
        html.classList.add(OBSERVED_CLASS);
        observer.observe(item.el);
        observed++;
      }
      return observed;
    }

    async function flushLazyQueue() {
      if (lazyFlushRunning || lazyPending.size === 0) return;
      const jobId = activePageJobId;
      if (!jobId) {
        lazyPending.forEach((item) => (item.el as HTMLElement).classList.remove(PENDING_CLASS));
        lazyPending.clear();
        return;
      }
      const items = Array.from(lazyPending.values()).filter((item) => item.el.isConnected);
      lazyPending.clear();
      if (items.length === 0) return;
      lazyFlushRunning = true;
      try {
        const chunks = planTextChunks(items, (item) => item.text, {
          maxItems: DYNAMIC_CHUNK_ITEMS,
          maxCharacters: DYNAMIC_CHUNK_CHARACTERS,
        });
        const failures = await runChunkQueue(chunks, LAZY_CONCURRENCY, (chunk) => translateChunk(chunk, jobId));
        if (activePageJobId === jobId) {
          const savedText = estimatedTokensSaved > 0 ? ` · 约省 ${estimatedTokensSaved} Token` : '';
          const failureText = failures > 0 ? ` · ${failures} 批失败` : '';
          showStatus(`已翻译 ${translatedCount} 段${savedText}${failureText} · 滚动时继续`, true);
        }
      } finally {
        if (activePageJobId === jobId) {
          lazyFlushRunning = false;
          if (lazyPending.size > 0) scheduleLazyFlush(60);
        }
      }
    }

    function stopLazyTranslation() {
      viewportObserver?.disconnect();
      viewportObserver = null;
      if (lazyFlushTimer) clearTimeout(lazyFlushTimer);
      lazyFlushTimer = null;
      lazyPending.forEach((item) => (item.el as HTMLElement).classList.remove(PENDING_CLASS));
      lazyPending.clear();
      lazyFlushRunning = false;
    }

    // 批量响应条目数异常（模型偶发漏条目）时的逐条回退：确保整页翻译不被单批错误中断，
    // 其余批次与懒翻译继续正常进行，且不会触发 notice 刷屏。
    async function fallbackTranslateIndividually(
      items: { el: Element; text: string }[],
      jobId: string | undefined,
    ): Promise<void> {
      const snapshotRevision = translationConfigRevision;
      let inserted = 0;
      await Promise.all(
        items.map(async (item) => {
          if (jobId && activePageJobId !== jobId) return;
          try {
            const r: any = await sendRuntimeMessage({
              type: 'TRANSLATE_ONE',
              payload: { text: item.text },
            });
            const t = r?.ok && typeof r.translation === 'string' ? r.translation : '';
            if (snapshotRevision === translationConfigRevision) {
              sessionTranslations.remember(item.text, t || item.text);
            }
            if (applyTranslation(item.el, item.text, t) === 'inserted') inserted++;
          } catch {
            /* 单条失败不影响整页其余内容 */
          }
        }),
      );
      translatedCount += inserted;
      if (inserted > 0) showStatus(`翻译中… 已译 ${translatedCount} 段`);
    }

    async function translateChunk(items: { el: Element; text: string }[], jobId?: string) {
      if (jobId && (activePageJobId !== jobId || blockedPageJobId === jobId)) {
        items.forEach((item) => (item.el as HTMLElement).classList.remove(PENDING_CLASS));
        return;
      }
      const requestConfigRevision = translationConfigRevision;
      try {
        const texts = items.map((x) => x.text);
        const res = await sendRuntimeMessage({
          type: 'TRANSLATE_BATCH',
          payload: { texts, jobId },
        }) as {
          ok?: boolean;
          translations?: unknown;
          stats?: { estimatedTokensSaved?: number };
          error?: string;
        } | undefined;
        if (jobId && activePageJobId !== jobId) return;
        if (!res?.ok) throw new Error(res?.error || '翻译失败');
        const translations = res.translations;
        if (!Array.isArray(translations) || translations.length !== items.length) {
          // 批量响应条目数异常：逐条回退翻译，避免整页翻译被单批错误中断。
          await fallbackTranslateIndividually(items, jobId);
          return;
        }
        const saved = Number(res.stats?.estimatedTokensSaved) || 0;
        estimatedTokensSaved += Math.max(0, saved);

        // 译文直接嵌入原文下方（<span>+display:block，见 makeTranslationNode），形成双语对照
        let inserted = 0;
        const stale: TranslationItem[] = [];
        items.forEach((x, k) => {
          const t = typeof translations[k] === 'string' ? translations[k] : '';
          // 即使无需翻译也记住原文，避免组件重建时重复走消息与模型链路。
          if (requestConfigRevision === translationConfigRevision) {
            sessionTranslations.remember(x.text, t || x.text);
          }
          const outcome = applyTranslation(x.el, x.text, t);
          if (outcome === 'inserted') inserted++;
          else if (outcome === 'stale') {
            const currentText = textOfBlock(x.el);
            (x.el as HTMLElement).classList.remove(PENDING_CLASS);
            if (currentText.length >= 2) stale.push({ el: x.el, text: currentText });
          }
          retryCounts.delete(x.el);
        });
        if (stale.length > 0 && (!jobId || activePageJobId === jobId)) {
          observeForLazyTranslation(stale);
        }
        translatedCount += inserted;
        if (inserted > 0) {
          const savedText = estimatedTokensSaved > 0 ? ` · 约省 ${estimatedTokensSaved} Token` : '';
          showStatus(`翻译中… 已译 ${translatedCount} 段${savedText}`);
        }
      } catch (error) {
        if (jobId && activePageJobId !== jobId) return;
        const message = error instanceof Error ? error.message : '翻译失败';
        showNotice(message, jobId || 'page-translation');
        const canRetry = isRetryableTranslationError(error);
        if (!canRetry && jobId) blockedPageJobId = jobId;
        const retryable = canRetry ? items.filter((item) => {
          if (!item.el.isConnected) return false;
          const attempts = retryCounts.get(item.el) || 0;
          if (attempts >= MAX_TRANSLATION_RETRIES) return false;
          retryCounts.set(item.el, attempts + 1);
          return true;
        }) : [];
        if (retryable.length > 0) {
          setTimeout(() => {
            if (!jobId || activePageJobId === jobId) observeForLazyTranslation(retryable);
          }, 500);
        }
        throw error;
      } finally {
        // 失败时允许后续动态扫描重试；成功时 markTranslated 已移除此标记。
        items.forEach((x) => (x.el as HTMLElement).classList.remove(PENDING_CLASS));
      }
    }

    // ===== 整页翻译（沉浸式叠加层：译文贴在原文正下方，不改动原网页）=====
    async function translatePage(initial = true) {
      if (busy) return;
      busy = true;

      let jobId: string | null = null;
      try {
        // 先清理旧译文层，防止堆叠
        clearTranslations();
        jobId = randomId();
        activePageJobId = jobId;
        setToolbarLoading(true);
        showStatus('翻译中…');

        const visible: TranslationItem[] = [];
        let deferredCount = 0;
        let foundCount = 0;
        let releaseFirstScan!: () => void;
        let firstScanReleased = false;
        const firstScanReady = new Promise<void>((resolve) => {
          releaseFirstScan = () => {
            if (firstScanReleased) return;
            firstScanReleased = true;
            resolve();
          };
        });
        const firstScanTimer = setTimeout(releaseFirstScan, 50);
        const scanPromise = scanTextBlocksIncrementally(
          document.body,
          (blocks) => {
            if (activePageJobId !== jobId) return;
            const deferred: TranslationItem[] = [];
            for (const item of blocks) {
              const { el, text } = item;
              foundCount++;
              if (isInViewport(el)) visible.push(item);
              else deferred.push(item);
            }
            deferredCount += observeForLazyTranslation(deferred);
            if (visible.length >= FIRST_CHUNK_ITEMS) releaseFirstScan();
          },
          {
            batchSize: 12,
            nodeBudget: 240,
            shouldContinue: () => activePageJobId === jobId,
          },
        ).finally(releaseFirstScan);

        await firstScanReady;
        clearTimeout(firstScanTimer);
        if (activePageJobId !== jobId) return;

        // 只从队列移除实际进入首批的元素。若字符上限先触发，其余可见段落仍留在队列中。
        const firstChunk = takeFirstTextChunk(visible, (item) => item.text, {
          maxItems: FIRST_CHUNK_ITEMS,
          maxCharacters: FIRST_CHUNK_CHARACTERS,
        });
        firstChunk.forEach((item) => (item.el as HTMLElement).classList.add(PENDING_CLASS));
        let failures = 0;
        if (firstChunk.length > 0) {
          try {
            await translateChunk(firstChunk, jobId);
          } catch {
            failures++;
          }
        }
        await scanPromise;
        if (activePageJobId !== jobId) return;
        if (foundCount === 0) {
          showStatus('未找到可翻译的文本内容', true);
          return;
        }

        const remaining = visible.splice(0);
        remaining.forEach((item) => (item.el as HTMLElement).classList.add(PENDING_CLASS));
        const chunks = planTextChunks(remaining, (item) => item.text, {
          maxItems: PAGE_CHUNK_ITEMS,
          maxCharacters: PAGE_CHUNK_CHARACTERS,
        });
        failures += await runChunkQueue(chunks, LAZY_CONCURRENCY, (chunk) =>
          translateChunk(chunk, jobId!),
        );
        if (activePageJobId !== jobId) return;

        if (failures > 0) {
          showStatus(`已翻译 ${translatedCount} 段，${failures} 个批次失败`, true);
        } else if (translatedCount === 0) {
          const savedText = estimatedTokensSaved > 0 ? `，本地约省 ${estimatedTokensSaved} Token` : '';
          showStatus(`无需翻译（内容已为目标语言）${savedText}`, true);
        } else {
          const savedText = estimatedTokensSaved > 0 ? ` · 约省 ${estimatedTokensSaved} Token` : '';
          const lazyText = deferredCount > 0 ? ' · 滚动时继续' : '';
          showStatus(`已翻译 ${translatedCount} 段${savedText}${lazyText}`, true);
        }
      } catch (e: any) {
        showNotice(e?.message || '翻译失败', jobId || 'page-translation');
      } finally {
        busy = false;
        setToolbarLoading(false);
        if (initial && activePageJobId === jobId) startDynamicTranslation();
      }
    }

    // ===== 动态内容自动翻译 =====
    function startDynamicTranslation() {
      if (dynamicActive || !document.body) return;
      dynamicActive = true;

      // 动态新增内容同样只注册观察，进入视口前不会调用翻译 API。
      const queue = (root: Element | Document) => {
        // 单次突变最多收集 300 段，防止巨型子树阻塞；不设生命周期总上限，
        // 因而无限滚动页面不会在累计 2000 段后永久停止工作。
        const blocks = collectTextBlocks(root, 300);
        const items = blocks.map((el) => ({ el, text: textOfBlock(el) }));
        observeForLazyTranslation(items);
      };

      const release = (element: Element) => {
        viewportObserver?.unobserve(element);
        lazyPending.delete(element);
        const translation = translationNodes.get(element);
        if (translation?.isConnected) translatedCount = Math.max(0, translatedCount - 1);
        translation?.remove();
        translationNodes.delete(element);
        const classes = (element as HTMLElement).classList;
        classes?.remove(PENDING_CLASS, OBSERVED_CLASS, TRANSLATED_CLASS);
      };

      const releaseRemovedSubtree = (root: Element) => {
        release(root);
        root.querySelectorAll('*').forEach(release);
      };

      const scheduleRoot = (root: Element) => {
        if (!root.isConnected || root.closest('#ot-error-modal, .ot-translation, .ot-img-panel, .ot-img-seg, #ot-toolbar, #ot-status, .ot-selbtn')) return;
        dynamicRoots.add(root);
        if (dynamicQueueTimer) clearTimeout(dynamicQueueTimer);
        dynamicQueueTimer = setTimeout(() => {
          dynamicQueueTimer = null;
          const roots = Array.from(dynamicRoots).filter((element) => element.isConnected);
          dynamicRoots.clear();
          if (roots.length > 24) {
            queue(document.body);
            return;
          }
          const compact = roots.filter((root, index) =>
            !roots.some((other, otherIndex) => otherIndex !== index && other.contains(root)),
          );
          compact.forEach(queue);
        }, 80);
      };

      const refreshChangedText = (element: Element) => {
        const anchor = closestTextBlock(element, true);
        if (!anchor) return;
        release(anchor);
        scheduleRoot(anchor);
      };

      const normalizedSiteClasses = (value: string | null) =>
        (value || '')
          .split(/\s+/)
          .filter(Boolean)
          .filter((name) => name !== PENDING_CLASS && name !== OBSERVED_CLASS && name !== TRANSLATED_CLASS)
          .sort()
          .join(' ');

      dynamicObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'characterData') {
            const parent = m.target.parentElement;
            if (parent) refreshChangedText(parent);
            continue;
          }
          if (m.type === 'attributes') {
            const target = m.target as Element;
            if (target.closest('#ot-error-modal, .ot-translation, .ot-img-panel, .ot-img-seg, #ot-toolbar, #ot-status, .ot-selbtn')) continue;
            if (
              m.attributeName === 'class' &&
              normalizedSiteClasses(m.oldValue) === normalizedSiteClasses(target.getAttribute('class'))
            ) continue;
            scheduleRoot(target);
            continue;
          }
          let parentTextChanged = false;
          m.removedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (!closestTextBlock(node as Element, true)) parentTextChanged = true;
              releaseRemovedSubtree(node as Element);
            }
            if (node.nodeType === Node.TEXT_NODE) parentTextChanged = true;
          });
          m.addedNodes.forEach((node) => {
            if (node.nodeType === Node.TEXT_NODE) {
              parentTextChanged = true;
              return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            const el = node as Element;
            const cls = (el as HTMLElement).classList;
            if (
              cls?.contains('ot-translation') ||
              cls?.contains('ot-status') ||
              cls?.contains(PENDING_CLASS) ||
              cls?.contains('ot-img-panel') ||
              cls?.contains('ot-img-seg') ||
              el.id === 'ot-toolbar'
            ) {
              return;
            }
            const containingBlock = closestTextBlock(el, true);
            if (containingBlock && containingBlock !== el) refreshChangedText(containingBlock);
            scheduleRoot(el);
          });
          if (parentTextChanged && m.target instanceof Element) refreshChangedText(m.target);
        }
      });
      dynamicObserver.observe(document.body, {
        childList: true,
        characterData: true,
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden'],
        subtree: true,
      });

      // ★ 修复：click-scan 不再重扫全屏（会导致已处理的元素被重复翻译）
      // 改为只扫描 display:none → visible 切换的元素（通过检查可见性变化来发现新内容）
      dynamicClickHandler = (e: Event) => {
        if (dynamicClickTimer) clearTimeout(dynamicClickTimer);
        const target = e.target as Element | null;
        dynamicClickTimer = setTimeout(() => {
          dynamicClickTimer = null;
          if (!dynamicActive || !target || target.nodeType !== 1) return;
          const root = target as Element;
          // 全页点击（点到 body / html 本身）直接交给 MutationObserver，不再整页重扫；
          // 只对点击元素子树做有界扫描，避免每次点击都遍历整棵 DOM 造成卡顿
          //（回归 0.1.0 修复前的“翻译变慢”问题）。Portal 菜单 / 显隐切换由 MutationObserver 接管。
          if (root === document.body || root === document.documentElement) return;
          const blocks = collectTextBlocks(root, 200);
          const newFound: TranslationItem[] = [];
          for (const b of blocks) {
            const el = b as HTMLElement;
            if (
              el.classList.contains(PENDING_CLASS) ||
              el.classList.contains(TRANSLATED_CLASS) ||
              el.classList.contains(OBSERVED_CLASS) ||
              el.classList.contains('ot-translation')
            )
              continue;
            const txt = textOfBlock(el);
            if (txt.length < 2) continue;
            if (!isVisible(el)) continue;
            // 额外保护：跳过我们自己的节点
            if (el.closest('.ot-translation, .ot-img-panel, .ot-toolbar, #ot-toolbar, #ot-status, .ot-selbtn'))
              continue;
            newFound.push({ el, text: txt });
          }
          observeForLazyTranslation(newFound);
        }, 120);
      };
      document.addEventListener('click', dynamicClickHandler, true);
    }

    function stopDynamic() {
      dynamicObserver?.disconnect();
      dynamicObserver = null;
      if (dynamicClickHandler) document.removeEventListener('click', dynamicClickHandler, true);
      dynamicClickHandler = null;
      if (dynamicClickTimer) clearTimeout(dynamicClickTimer);
      dynamicClickTimer = null;
      if (dynamicQueueTimer) clearTimeout(dynamicQueueTimer);
      dynamicQueueTimer = null;
      dynamicRoots.clear();
      dynamicActive = false;
    }

    // ---- 划词翻译：结果留在独立浮层中，不改写正文，也不会覆盖整段译文。 ----
    type SelectionSnapshot = { text: string; rect: DOMRect };
    let selectionHost: HTMLDivElement | null = null;
    let selectionSnapshot: SelectionSnapshot | null = null;
    let selectionPinned = false;
    let selectionTimer: ReturnType<typeof setTimeout> | null = null;
    let selectionRequestId = 0;

    function hideSelectionUi() {
      selectionRequestId++;
      selectionHost?.remove();
      selectionHost = null;
      selectionSnapshot = null;
      selectionPinned = false;
    }

    function captureSelection(): SelectionSnapshot | null {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
      const text = selection.toString().replace(/\s+/g, ' ').trim();
      if (!text) return null;
      const range = selection.getRangeAt(0);
      const start = range.startContainer.nodeType === Node.TEXT_NODE
        ? range.startContainer.parentElement
        : range.startContainer as Element;
      if (!start || start.closest('#ot-selection-ui, #ot-error-modal, .ot-translation, #ot-toolbar, #ot-status')) {
        return null;
      }
      const root = start.getRootNode();
      if (root instanceof ShadowRoot && root.host.matches('#ot-selection-ui, .ot-translation')) return null;
      const rects = range.getClientRects();
      const rect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return null;
      return { text, rect };
    }

    function positionSelectionUi(host: HTMLElement, rect: DOMRect, expanded: boolean) {
      const width = expanded ? Math.min(360, window.innerWidth - 16) : 36;
      const left = Math.min(
        Math.max(8, rect.right + 8),
        Math.max(8, window.innerWidth - width - 8),
      );
      const estimatedHeight = expanded ? 190 : 36;
      const below = rect.bottom + 8;
      const top = below + estimatedHeight <= window.innerHeight - 8
        ? below
        : Math.max(8, rect.top - estimatedHeight - 8);
      host.style.setProperty('left', `${left}px`, 'important');
      host.style.setProperty('top', `${top}px`, 'important');
      requestAnimationFrame(() => {
        if (!host.isConnected) return;
        const box = host.getBoundingClientRect();
        if (box.right > window.innerWidth - 8) {
          host.style.setProperty('left', `${Math.max(8, window.innerWidth - box.width - 8)}px`, 'important');
        }
        if (box.bottom > window.innerHeight - 8) {
          host.style.setProperty('top', `${Math.max(8, rect.top - box.height - 8)}px`, 'important');
        }
      });
    }

    function selectionUiStyle(): HTMLStyleElement {
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

    function createSelectionHost(snapshot: SelectionSnapshot): HTMLDivElement {
      hideSelectionUi();
      const host = document.createElement('div');
      host.id = 'ot-selection-ui';
      host.className = 'ot-selbtn';
      host.dataset.haofanUi = 'true';
      host.style.setProperty('all', 'initial', 'important');
      host.style.setProperty('position', 'fixed', 'important');
      host.style.setProperty('z-index', '2147483647', 'important');
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.appendChild(selectionUiStyle());
      document.documentElement.appendChild(host);
      selectionHost = host;
      selectionSnapshot = snapshot;
      return host;
    }

    function renderSelectionPanel(host: HTMLDivElement, snapshot: SelectionSnapshot, translation?: string) {
      const shadow = host.shadowRoot!;
      shadow.querySelectorAll(':not(style)').forEach((node) => node.remove());
      const panel = document.createElement('section');
      panel.className = 'panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', '划词翻译结果');
      const head = document.createElement('div');
      head.className = 'head';
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = '划词翻译';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'close';
      close.textContent = '×';
      close.title = '关闭';
      close.setAttribute('aria-label', '关闭划词翻译');
      close.addEventListener('click', hideSelectionUi);
      head.append(title, close);
      const source = document.createElement('div');
      source.className = 'source';
      source.textContent = snapshot.text.length > 180 ? `${snapshot.text.slice(0, 180)}…` : snapshot.text;
      const result = document.createElement('div');
      result.className = translation === undefined ? 'result loading' : 'result';
      result.setAttribute('aria-live', 'polite');
      result.textContent = translation === undefined ? '翻译中…' : translation;
      panel.append(head, source, result);
      if (translation !== undefined) {
        const actions = document.createElement('div');
        actions.className = 'actions';
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'action';
        copy.textContent = '复制';
        copy.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(translation);
            copy.textContent = '已复制';
            setTimeout(() => { if (copy.isConnected) copy.textContent = '复制'; }, 1200);
          } catch {
            copy.textContent = '复制失败';
          }
        });
        actions.appendChild(copy);
        panel.appendChild(actions);
      }
      shadow.appendChild(panel);
      positionSelectionUi(host, snapshot.rect, true);
    }

    async function translateSelectionInPopover(
      snapshot: SelectionSnapshot,
      host: HTMLDivElement,
      operationId = `selection-${randomId()}`,
    ) {
      selectionPinned = true;
      renderSelectionPanel(host, snapshot);
      const requestId = ++selectionRequestId;
      const cached = sessionTranslations.get(snapshot.text);
      if (cached !== undefined) {
        if (host === selectionHost) renderSelectionPanel(host, snapshot, cached);
        return;
      }
      const requestConfigRevision = translationConfigRevision;
      try {
        const res: any = await sendRuntimeMessage({ type: 'TRANSLATE_ONE', payload: { text: snapshot.text } });
        if (requestId !== selectionRequestId || host !== selectionHost) return;
        if (!res?.ok) throw new Error(res?.error || '翻译失败');
        const translation = typeof res.translation === 'string' ? res.translation : '';
        if (!translation) throw new Error('未返回有效译文');
        if (requestConfigRevision === translationConfigRevision) {
          sessionTranslations.remember(snapshot.text, translation);
        }
        renderSelectionPanel(host, snapshot, translation);
      } catch (error) {
        if (requestId !== selectionRequestId || host !== selectionHost) return;
        renderSelectionPanel(host, snapshot, '翻译失败');
        showNotice(error instanceof Error ? error.message : '翻译失败', operationId);
      }
    }

    function showSelectionUi(snapshot: SelectionSnapshot, translateImmediately = false) {
      const host = createSelectionHost(snapshot);
      positionSelectionUi(host, snapshot.rect, false);
      if (translateImmediately) {
        void translateSelectionInPopover(snapshot, host);
        return;
      }
      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'trigger';
      trigger.textContent = '译';
      trigger.title = '翻译选中内容';
      trigger.setAttribute('aria-label', '翻译选中内容');
      trigger.addEventListener('pointerdown', (event) => event.preventDefault());
      trigger.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void translateSelectionInPopover(snapshot, host);
      });
      host.shadowRoot!.appendChild(trigger);
    }

    function refreshSelectionUi() {
      if (selectionPinned) return;
      const snapshot = captureSelection();
      if (snapshot) showSelectionUi(snapshot);
      else hideSelectionUi();
    }

    document.addEventListener('pointerup', (event) => {
      if (selectionHost && event.composedPath().includes(selectionHost)) return;
      setTimeout(refreshSelectionUi, 0);
    });
    document.addEventListener('keyup', (event) => {
      if (event.key === 'Escape') {
        hideSelectionUi();
        return;
      }
      if (event.shiftKey || event.key.startsWith('Arrow')) setTimeout(refreshSelectionUi, 0);
    });
    document.addEventListener('selectionchange', () => {
      if (selectionPinned) return;
      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = setTimeout(refreshSelectionUi, 160);
    });
    document.addEventListener('pointerdown', (event) => {
      if (selectionHost && !event.composedPath().includes(selectionHost)) hideSelectionUi();
    }, true);
    window.addEventListener('scroll', () => {
      if (!selectionPinned) hideSelectionUi();
    }, true);

    // 接收来自 background 的指令
    runtime.onMessage.addListener((msg: any) => {
      if (msg?.type === 'TRANSLATE_PAGE') translatePage(true);
      else if (msg?.type === 'SHOW_IMAGE_RESULT') showImageResult(msg.payload?.srcUrl, msg.payload?.result);
      else if (msg?.type === 'SHOW_ERROR') {
        showNotice(msg.payload?.message || '操作失败', `external-${randomId()}`);
      }
      else if (msg?.type === 'TRANSLATE_SELECTION') {
        const snapshot = captureSelection();
        if (snapshot) showSelectionUi(snapshot, true);
      }
    });

    // ============================================================
    // ★ 悬浮工具按钮 — 彻底重构：确保在任何网页上都可见
    // ============================================================
    function mountToolbar() {
      if (document.getElementById('ot-toolbar')) return;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'ot-toolbar';
      btn.textContent = '\u8BD1'; // "译"
      btn.title = '好翻 \u00B7 \u7FFB\u8BD1\u672C\u9875'; // "好翻 · 翻译本页"
      btn.setAttribute('aria-label', '翻译当前网页');

      // 使用内联样式覆盖一切可能的站点 CSS 干扰
      // 关键：position:fixed 必须在无 transform/filter/perspective 的祖先下才有效
      // 挂载到 documentElement 而非 body，避免 body 的 transform 破坏固定定位
      Object.assign(btn.style, {
        position: 'fixed',
        right: '20px',
        bottom: '20px',
        zIndex: '2147483647',
        width: '44px',
        height: '44px',
        borderRadius: '50%',
        background: '#1a73e8',
        color: '#fff',
        fontWeight: '600',
        fontSize: '16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        userSelect: 'none',
        boxShadow: '0 2px 8px rgba(0,113,227,0.35), 0 8px 24px rgba(0,0,0,0.18)',
        transition: 'transform 0.15s ease, background 0.2s ease',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        border: 'none',
        padding: '0',
        lineHeight: '1',
      });

      btn.addEventListener('mouseenter', () => {
        btn.style.background = '#1765cc';
        btn.style.transform = 'translateY(-2px)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = '#1a73e8';
        btn.style.transform = 'translateY(0)';
      });
      btn.addEventListener('mousedown', () => {
        btn.style.transform = 'scale(0.94)';
      });
      btn.addEventListener('mouseup', () => {
        btn.style.transform = 'translateY(-1px)';
      });
      btn.addEventListener('click', () => {
        if (busy) {
          clearTranslations();
          busy = false;
          setToolbarLoading(false);
          showStatus('已取消翻译', true);
          return;
        }
        if (document.querySelectorAll('.ot-translation').length > 0) {
          // 已有译文 → 收起（清理译文与标记）
          clearTranslations();
        } else {
          translatePage(true);
        }
      });

      // 挂载到 documentElement（html 节点），避免页面 body 有 transform 时破坏 fixed 定位
      try {
        document.documentElement.appendChild(btn);
      } catch {
        // 极少数情况下 documentElement 不可写，退回 body
        (document.body || document.documentElement).appendChild(btn);
      }
    }

    function setToolbarLoading(loading: boolean) {
      const btn = document.getElementById('ot-toolbar');
      if (!btn) return;
      if (loading) {
        // 加载态同时作为取消按钮。
        btn.setAttribute('aria-busy', 'true');
        btn.setAttribute('aria-label', '取消当前翻译');
        btn.style.setProperty('width', 'auto', 'important');
        btn.style.setProperty('padding', '0 14px', 'important');
        btn.style.setProperty('border-radius', '22px', 'important');
        btn.style.setProperty('font-size', '13px', 'important');
        btn.style.setProperty('background', '#8fb8ef', 'important');
        btn.style.cursor = 'progress';
        btn.textContent = '取消翻译';
        btn.title = '取消当前翻译';
      } else {
        btn.setAttribute('aria-busy', 'false');
        btn.setAttribute('aria-label', '翻译当前网页');
        btn.style.removeProperty('width');
        btn.style.removeProperty('padding');
        btn.style.removeProperty('border-radius');
        btn.style.removeProperty('font-size');
        btn.style.setProperty('background', '#1a73e8', 'important');
        btn.style.cursor = 'pointer';
        btn.textContent = '译';
        btn.title = '好翻 · 翻译本页';
      }
    }

    mountToolbar();

    // SPA 自愈：toolbar 被页面 JS 移除时自动重建
    if (document.body) {
      new MutationObserver(() => {
        if (!document.getElementById('ot-toolbar')) mountToolbar();
      }).observe(document.body, { childList: true });
    }
  },
});

// ===== 图片翻译相关（在模块顶层，不在 main() 内，避免重复定义）=====
function findImage(srcUrl?: string): HTMLImageElement | null {
  if (!srcUrl) return null;
  const imgs = Array.from(document.images) as HTMLImageElement[];
  return imgs.find((im) => im.currentSrc === srcUrl || im.src === srcUrl) ?? null;
}

function showImageResult(srcUrl: string | undefined, result: any) {
  activeImageCleanup?.();
  const img = findImage(srcUrl);
  const segments: any[] = Array.isArray(result?.segments) ? result.segments : [];

  const boxes: HTMLElement[] = [];
  if (img) {
    segments.forEach((s) => {
      const box = document.createElement('div');
      box.className = 'ot-img-seg';
      box.textContent = s.translation || s.text;
      document.body.appendChild(box);
      boxes.push(box);
    });
  }

  const panel = document.createElement('div');
  panel.className = 'ot-img-panel';
  const head = document.createElement('div');
  head.className = 'ot-img-head';
  const title = document.createElement('span');
  title.textContent = '\u597D\u7FFB \u00B7 \u56FE\u7247\u7FFB\u8BD1'; // "好翻 · 图片翻译"
  const close = document.createElement('button');
  close.className = 'ot-img-close';
  close.textContent = '\u00D7'; // ×
  close.title = '\u5173\u95ED'; // "关闭"
  head.appendChild(title);
  head.appendChild(close);
  panel.appendChild(head);

  const toggleLabel = document.createElement('label');
  toggleLabel.className = 'ot-img-toggle';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = true;
  toggleLabel.appendChild(toggle);
  toggleLabel.appendChild(document.createTextNode('\u5728\u56FE\u4E0A\u6807\u8BB0\u8BD1\u6587')); // " 在图上标记译文"
  panel.appendChild(toggleLabel);

  const list = document.createElement('div');
  list.className = 'ot-img-list';
  if (segments.length === 0) {
    list.innerHTML = '<div class="ot-img-empty">\u672A\u8BC6\u522B\u5230\u6587\u5B57</div>'; // "未识别到文字"
  } else {
    segments.forEach((s) => {
      const item = document.createElement('div');
      item.className = 'ot-img-item';
      const src = document.createElement('div');
      src.className = 'src';
      src.textContent = s.text;
      const dst = document.createElement('div');
      dst.className = 'dst';
      dst.textContent = s.translation;
      item.appendChild(src);
      item.appendChild(dst);
      list.appendChild(item);
    });
  }
  panel.appendChild(list);
  document.body.appendChild(panel);

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    panel.remove();
    boxes.forEach((b) => b.remove());
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition);
    if (activeImageCleanup === cleanup) activeImageCleanup = null;
  }
  activeImageCleanup = cleanup;
  close.addEventListener('click', cleanup);
  toggle.addEventListener('change', () => {
    boxes.forEach((b) => (b.style.display = toggle.checked ? '' : 'none'));
  });

  function reposition() {
    if (!img) {
      panel.style.right = '16px';
      panel.style.top = '16px';
      panel.style.left = 'auto';
      return;
    }
    const r = img.getBoundingClientRect();
    const panelW = panel.offsetWidth || 300;
    const panelH = panel.offsetHeight || 200;
    let left = r.right + 12;
    let top = r.top;
    if (left + panelW > window.innerWidth - 8) {
      left = r.left;
      top = r.bottom + 12;
    }
    if (top + panelH > window.innerHeight - 8) top = Math.max(8, window.innerHeight - panelH - 8);
    panel.style.left = Math.max(8, left) + 'px';
    panel.style.top = Math.max(8, top) + 'px';
    panel.style.right = 'auto';

    const iw = r.width;
    const ih = r.height;
    boxes.forEach((b, i) => {
      const s = segments[i];
      if (!s) return;
      b.style.left = r.left + s.x * iw + 'px';
      b.style.top = r.top + s.y * ih + 'px';
      b.style.width = s.w * iw + 'px';
      b.style.height = s.h * ih + 'px';
    });
  }

  reposition();
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
}
