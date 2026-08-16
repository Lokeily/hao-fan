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
} from '../utils/dom.ts';
import { planTextChunks, takeFirstTextChunk } from '../utils/chunking.ts';
import { configItem, disabledSitesItem, toolbarPosItem } from '../utils/storage.ts';
import {
  createTranslationNode,
  createNoticeHost,
  createSelectionUiStyle,
} from '../utils/content-ui.ts';
import { buildConfigForm } from '../utils/ui.ts';
import { mountImageResultOverlay } from '../utils/image-overlay.ts';
import { isRetryableTranslationError, NoticeCycleGate } from '../utils/notice-policy.ts';
import { SessionTranslationCache } from '../utils/session-translation-cache.ts';
import { randomId } from '../utils/id.ts';
import { isSiteDisabled } from '../utils/site-policy.ts';
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
    let totalSegCount = 0; // 本次翻译预计总段数（用于"已译 X / Y 段"进度）
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
    const lazyPending = new Map<Element, TranslationItem>();
    let lazyFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let lazyFlushRunning = false;
    let translationNodes = new WeakMap<Element, HTMLSpanElement>();
    let retryCounts = new WeakMap<Element, number>();
    const sessionTranslations = new SessionTranslationCache();
    let translationConfigRevision = 0;
    let noticeHost: HTMLElement | null = null;
    const noticeCycles = new NoticeCycleGate();
    let blockedPageJobId: string | null = null;
    let siteDisabled = false;
    let sitePolicyLoaded = false;
    let sitePolicyRevision = 0;

    try {
      disabledSitesItem.watch((sites) => {
        sitePolicyRevision++;
        setSiteDisabledState(isSiteDisabled(sites, location.href));
      });
    } catch {
      /* 存储监听不可用时，仍使用首次读取到的站点规则。 */
    }
    const initialSitePolicyRevision = sitePolicyRevision;
    const sitePolicyReady = disabledSitesItem
      .getValue()
      .then((sites) => {
        if (sitePolicyRevision === initialSitePolicyRevision) {
          setSiteDisabledState(isSiteDisabled(sites, location.href));
        }
      })
      .catch(() => {
        if (!sitePolicyLoaded) setSiteDisabledState(false);
      });

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

    // MV3 后台 Service Worker 会在空闲约 30s 后被挂起；若其崩溃或正处于重启中，
    // runtime.sendMessage 可能永久挂起（既无响应也不报错），导致整页翻译静默卡死。
    // 这里加一道上限远长于单次网络超时（20s×重试）的兜底超时，超时即抛出可感知错误，
    // 由上层失败/重试路径接管，避免界面假死。
    const RUNTIME_MSG_TIMEOUT_MS = 90_000;
    async function sendRuntimeMessage(message: unknown): Promise<any> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('与后台服务通信超时，请刷新网页或稍后重试')),
          RUNTIME_MSG_TIMEOUT_MS,
        );
      });
      try {
        return await Promise.race([runtime.sendMessage(message), timeout]);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (/context invalidated|extension context|runtime.*undefined/i.test(detail)) {
          throw new Error('扩展已更新，请刷新当前网页后重试', { cause: error });
        }
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
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

      noticeHost = createNoticeHost(title, message, closeNotice);
      document.documentElement.appendChild(noticeHost);
    }
    // ===== 译文嵌入（网页嵌入对照方案）：直接在原文文字下方插入译文节点 =====
    // 节点构建见 utils/content-ui.ts 的 createTranslationNode。
    function insertTranslation(
      el: Element,
      translation: string,
      options: { editable?: boolean; onEdit?: (s: string, e: string) => void; note?: string } = {},
    ) {
      // 流式 delta 直接调用本函数；若节点已被页面动态移除（导航/局部刷新），
      // 写入会抛错且发生在未 await 的监听回调中。先判连防异常，保持安静失败。
      if (!el.isConnected) return;
      const existing = translationNodes.get(el);
      if (existing?.isConnected) {
        const text = existing.shadowRoot?.querySelector('.text');
        if (text) text.textContent = translation;
        return;
      }
      const node = createTranslationNode(translation, el, options);
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
        const nestedList = Array.from(el.children).find(
          (child) => child.tagName === 'UL' || child.tagName === 'OL',
        );
        el.insertBefore(node, nestedList || null);
        return;
      }
      // 普通流中紧邻原文插入，多个段落即使共用 overflow:hidden 卡片也不会被搬出或倒序。
      // Flex/Grid 的直接子项不能新增兄弟项，否则会改变轨道布局，此时嵌入原语义块末尾。
      const parentDisplay = el.parentElement ? getComputedStyle(el.parentElement).display : '';
      const parentCreatesLayout =
        parentDisplay === 'flex' ||
        parentDisplay === 'inline-flex' ||
        parentDisplay === 'grid' ||
        parentDisplay === 'inline-grid';
      if (parentCreatesLayout) el.appendChild(node);
      else el.insertAdjacentElement('afterend', node);
    }

    // 术语自学习：用户手动修改译文后，短术语（≤30 字且无句末标点）沉淀进个人术语表，
    // 其余仅在本会话内记住修正结果。
    function learnTerm(source: string, edited: string) {
      sessionTranslations.remember(source, edited);
      if (source.trim().length <= 30 && !/[。.!?！？\n]/.test(source) && source.trim() !== edited.trim()) {
        void learnGlossaryTerm(source.trim(), edited.trim());
      }
    }
    async function learnGlossaryTerm(src: string, dst: string) {
      try {
        // 净化：剔除换行（避免破坏多行结构）；把源词里的分隔符 = / ＝ 换成 -（解析侧用 = 切分，
        // 源词含 = 会导致「a=b=c」被错误切分），保证术语库数据不会被污染。
        const safeSrc = src.replace(/[\r\n]+/g, ' ').replace(/[=＝]/g, '-').trim();
        const safeDst = dst.replace(/[\r\n]+/g, ' ').trim();
        if (!safeSrc || !safeDst) return;
        const cur = (await configItem.getValue()) || configItem.defaultValue;
        const base = cur.customGlossary ? cur.customGlossary.replace(/\s*$/, '') : '';
        const next = base ? `${base}\n${safeSrc}=${safeDst}` : `${safeSrc}=${safeDst}`;
        await configItem.setValue({ ...cur, customGlossary: next });
        showStatus('已记忆术语 ✓', true);
      } catch {
        /* 术语记忆失败不影响正文显示 */
      }
    }

    // 上下文感知：取「当前页面标题 + 紧邻前一段译文」，让模型在术语 / 语气上保持一致。
    function previousTextBlock(el: Element): string | undefined {
      let sib = el.previousElementSibling;
      if (!sib) {
        const parent = el.parentElement;
        if (parent) sib = parent.previousElementSibling;
      }
      if (!sib) return undefined;
      const txt = textOfBlock(sib).trim();
      return txt.length > 0 && txt.length <= 120 ? txt : undefined;
    }
    function buildPageContext(el?: Element): { title: string; previous?: string } {
      const ctx: { title: string; previous?: string } = { title: document.title || '' };
      if (el && el.isConnected) {
        const prev = previousTextBlock(el);
        if (prev) ctx.previous = prev;
      }
      return ctx;
    }

    function applyTranslation(
      el: Element,
      original: string,
      translation: string,
      note?: string,
    ): 'inserted' | 'skipped' | 'stale' {
      if (!el.isConnected || textOfBlock(el) !== original) return 'stale';
      if (!translation || translation === original) {
        markTranslated(el);
        return 'skipped';
      }
      insertTranslation(el, translation, { editable: true, onEdit: learnTerm, note });
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

    // 状态提示（"翻译中…" / "已译 X / Y 段"），紧贴悬浮按钮上方；加载态带旋转指示
    let statusEl: HTMLElement | null = null;
    let statusSpinner: HTMLElement | null = null;
    let statusText: HTMLElement | null = null;
    let statusTimer: ReturnType<typeof setTimeout> | null = null;
    function ensureStatusEl() {
      if (statusEl) return;
      statusEl = document.createElement('div');
      statusEl.id = 'ot-status';
      statusEl.setAttribute('role', 'status');
      statusEl.setAttribute('aria-live', 'polite');
      Object.assign(statusEl.style, {
        position: 'fixed',
        right: '20px',
        bottom: '74px',
        zIndex: '2147483646',
        display: 'flex',
        alignItems: 'center',
        gap: '7px',
        background: 'rgba(28,28,30,0.86)',
        color: '#fff',
        font: '12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        padding: '6px 11px',
        borderRadius: '8px',
        pointerEvents: 'none',
        boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
        opacity: '0',
        transition: 'opacity 0.2s ease',
        maxWidth: '260px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      });
      statusSpinner = document.createElement('span');
      statusSpinner.className = 'ot-spinner';
      statusSpinner.style.display = 'none';
      statusText = document.createElement('span');
      statusEl.append(statusSpinner, statusText);
      document.documentElement.appendChild(statusEl);
    }
    function showStatus(text: string, transient = false) {
      ensureStatusEl();
      statusSpinner!.style.display = 'none';
      statusText!.textContent = text;
      statusEl!.style.opacity = '1';
      if (statusTimer) clearTimeout(statusTimer);
      if (transient) {
        statusTimer = setTimeout(() => {
          if (statusEl) statusEl.style.opacity = '0';
        }, 2500);
      }
    }
    // 进度显示：已译 X / Y 段（Y 为本次预计总段数），加载态显示旋转指示
    function showProgress(loading = false) {
      ensureStatusEl();
      const savedText = estimatedTokensSaved > 0 ? ` · 约省 ${estimatedTokensSaved} Token` : '';
      const total = totalSegCount > 0 ? totalSegCount : translatedCount;
      statusSpinner!.style.display = loading ? 'inline-block' : 'none';
      statusText!.textContent = `已译 ${translatedCount} / ${total} 段${savedText}`;
      statusEl!.style.opacity = '1';
      if (statusTimer) clearTimeout(statusTimer);
      if (!loading) {
        statusTimer = setTimeout(() => {
          if (statusEl) statusEl.style.opacity = '0';
        }, 2500);
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
      document
        .querySelectorAll(`.${TRANSLATED_CLASS}`)
        .forEach((el) => (el as HTMLElement).classList.remove(TRANSLATED_CLASS));
      // 清除排队中标记
      document
        .querySelectorAll(`.${PENDING_CLASS}`)
        .forEach((el) => (el as HTMLElement).classList.remove(PENDING_CLASS));
      document
        .querySelectorAll(`.${OBSERVED_CLASS}`)
        .forEach((el) => (el as HTMLElement).classList.remove(OBSERVED_CLASS));
      translationNodes = new WeakMap<Element, HTMLSpanElement>();
      retryCounts = new WeakMap<Element, number>();
      blockedPageJobId = null;
      // 移除图片翻译层，并释放其滚动/缩放监听。
      activeImageCleanup?.();
      activeImageCleanup = null;
      document.querySelectorAll('.ot-img-panel, .ot-img-seg').forEach((el) => el.remove());
      translatedCount = 0;
      totalSegCount = 0;
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
      viewportObserver = new IntersectionObserver(
        (entries) => {
          let queued = false;
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            if (enqueueLazyItem(entry.target)) queued = true;
          }
          if (queued) scheduleLazyFlush();
        },
        {
          root: null,
          rootMargin: '320px 0px',
          threshold: 0,
        },
      );
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
        )
          continue;
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
        const failures = await runChunkQueue(chunks, LAZY_CONCURRENCY, (chunk) =>
          translateChunk(chunk, jobId),
        );
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
      let firstError: unknown;
      const stale: TranslationItem[] = [];
      const failures = await runChunkQueue(
        items.map((item) => [item]),
        LAZY_CONCURRENCY,
        async ([item]) => {
          if (jobId && activePageJobId !== jobId) return;
          try {
            const r: any = await sendRuntimeMessage({
              type: 'TRANSLATE_ONE',
              payload: { text: item.text, jobId, pageContext: buildPageContext(item.el) },
            });
            if (!r?.ok) throw new Error(r?.error || '逐条翻译失败');
            const t = typeof r.translation === 'string' ? r.translation : '';
            if (!t) throw new Error('翻译服务返回了空结果');
            if (jobId && activePageJobId !== jobId) return;
            if (snapshotRevision === translationConfigRevision) {
              sessionTranslations.remember(item.text, t);
            }
            const outcome = applyTranslation(item.el, item.text, t);
            if (outcome === 'inserted') inserted++;
            else if (outcome === 'stale') {
              const currentText = textOfBlock(item.el);
              if (currentText.length >= 2) stale.push({ el: item.el, text: currentText });
            }
            estimatedTokensSaved += Math.max(0, Number(r.stats?.estimatedTokensSaved) || 0);
            retryCounts.delete(item.el);
          } catch (error) {
            firstError ??= error;
            throw error;
          }
        },
      );
      if (jobId && activePageJobId !== jobId) return;
      if (stale.length > 0) observeForLazyTranslation(stale);
      translatedCount += inserted;
      if (inserted > 0) showProgress(true);
      if (failures > 0) {
        throw firstError instanceof Error ? firstError : new Error(`${failures} 段逐条翻译失败`);
      }
    }

    // 仅当错误指向「引擎整体不可用」（密钥/权限/端点/模型）时才令本页停机，
    // 否则（空结果、输出截断等可恢复错误）只跳过本批，让整页其余内容继续翻译。
    function isPageBlockingError(error: unknown): boolean {
      const message = error instanceof Error ? error.message : String(error);
      return /(请先在设置页填写 API Key|API Key 含有|未配置 API Base URL|不支持的翻译引擎|不支持的.*模型|401|403|Unauthorized|Forbidden)/i.test(
        message,
      );
    }

    async function translateChunk(items: { el: Element; text: string }[], jobId?: string) {
      if (jobId && (activePageJobId !== jobId || blockedPageJobId === jobId)) {
        items.forEach((item) => (item.el as HTMLElement).classList.remove(PENDING_CLASS));
        return;
      }
      const requestConfigRevision = translationConfigRevision;
      try {
        const texts = items.map((x) => x.text);
        const res = (await sendRuntimeMessage({
          type: 'TRANSLATE_BATCH',
          payload: { texts, jobId, pageContext: buildPageContext() },
        })) as
          | {
              ok?: boolean;
              translations?: unknown;
              notes?: unknown;
              stats?: { estimatedTokensSaved?: number };
              error?: string;
            }
          | undefined;
        if (jobId && activePageJobId !== jobId) return;
        if (!res?.ok) throw new Error(res?.error || '翻译失败');
        const translations = res.translations;
        if (!Array.isArray(translations) || translations.length !== items.length) {
          // 批量响应条目数异常（模型偶发漏条目 / 多余条目）。
          // 已成功返回的条目直接应用，仅对缺失或解析失败的条目逐条回退，
          // 避免把整批已成功的内容也重发一遍，浪费 Token 与请求额度；整页其余翻译继续。
          const missing: { el: Element; text: string }[] = [];
          let inserted = 0;
          const stale: TranslationItem[] = [];
          items.forEach((item, k) => {
            const t =
              Array.isArray(translations) && typeof translations[k] === 'string'
                ? (translations[k] as string)
                : '';
            if (t) {
              if (requestConfigRevision === translationConfigRevision) {
                sessionTranslations.remember(item.text, t);
              }
              const outcome = applyTranslation(
                item.el,
                item.text,
                t,
                Array.isArray(res.notes) ? ((res.notes as (string | null)[])[k] ?? undefined) : undefined,
              );
              if (outcome === 'inserted') inserted++;
              else if (outcome === 'stale') {
                (item.el as HTMLElement).classList.remove(PENDING_CLASS);
                const currentText = textOfBlock(item.el);
                if (currentText.length >= 2) stale.push({ el: item.el, text: currentText });
              }
              retryCounts.delete(item.el);
            } else {
              missing.push(item);
            }
          });
          if (stale.length > 0 && (!jobId || activePageJobId === jobId)) {
            observeForLazyTranslation(stale);
          }
          translatedCount += inserted;
          if (inserted > 0) showProgress(true);
          if (missing.length > 0) {
            await fallbackTranslateIndividually(missing, jobId);
          }
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
          const outcome = applyTranslation(
            x.el,
            x.text,
            t,
            Array.isArray(res.notes) ? ((res.notes as (string | null)[])[k] ?? undefined) : undefined,
          );
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
          showProgress(true);
        }
      } catch (error) {
        if (jobId && activePageJobId !== jobId) return;
        const message = error instanceof Error ? error.message : '翻译失败';
        showNotice(message, jobId || 'page-translation');
        const canRetry = isRetryableTranslationError(error);
        // 仅当错误指向「引擎整体不可用」（密钥/权限/端点/模型）才令本页停机；
        // 空结果、输出截断等可恢复错误只跳过本批，让整页其余内容继续翻译，
        // 避免一次小失败导致整页静默中断、用户误以为已翻完。
        if (isPageBlockingError(error) && jobId) blockedPageJobId = jobId;
        const retryable = canRetry
          ? items.filter((item) => {
              if (!item.el.isConnected) return false;
              const attempts = retryCounts.get(item.el) || 0;
              if (attempts >= MAX_TRANSLATION_RETRIES) return false;
              retryCounts.set(item.el, attempts + 1);
              return true;
            })
          : [];
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

    // 首块流式渲染：首段通过 haofan-stream 长连接端口「逐字流式」翻译，首字即可见；
    // 其余段落并行走普通批。端口失败 / 空结果 / 超时一律回退到普通 translateChunk，保证不漏译。
    async function translateFirstChunkStreamed(items: { el: Element; text: string }[], jobId?: string): Promise<boolean> {
      const head = items[0];
      const tail = items.slice(1);
      // 先插入首段的空可编辑节点，流式过程中就地更新其文本，避免空白闪烁。
      insertTranslation(head.el, '', { editable: true, onEdit: learnTerm });
      (head.el as HTMLElement).classList.add(PENDING_CLASS);
      let headDone = false;
      const finishHead = (translation: string) => {
        if (headDone) return;
        headDone = true;
        (head.el as HTMLElement).classList.remove(PENDING_CLASS);
        const outcome = applyTranslation(head.el, head.text, translation);
        if (outcome === 'inserted') translatedCount++;
        showProgress(true);
      };
      const fallbackHead = async () => {
        if (headDone) return;
        headDone = true;
        try {
          await translateChunk([head], jobId);
        } catch {
          /* 失败已由整体 notice 提示，这里不重复抛出 */
        }
      };
      const headPromise = new Promise<void>((resolve) => {
        let port: ReturnType<typeof runtime.connect> | null = null;
        let acc = '';
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          try {
            port?.disconnect();
          } catch {
            /* 端口可能已断开 */
          }
          resolve();
        };
        try {
          port = runtime.connect({ name: 'haofan-stream' });
        } catch {
          port = null;
        }
        if (!port) {
          void fallbackHead().then(settle);
          return;
        }
        port.onMessage.addListener((msg: any) => {
          if (!msg || settled) return;
          if (msg.type === 'delta') {
            acc += typeof msg.text === 'string' ? msg.text : '';
            insertTranslation(head.el, acc, { editable: true, onEdit: learnTerm });
          } else if (msg.type === 'done') {
            const t = typeof msg.text === 'string' && msg.text ? msg.text : acc;
            if (t) finishHead(t);
            else void fallbackHead();
            settle();
          } else if (msg.type === 'error') {
            void fallbackHead();
            settle();
          }
        });
        // 端口异常断开（如后台 Worker 崩溃重启）时，必须回退普通批翻译首段，
        // 否则首段节点会停留在空译文且 headDone 永不为真 → 首段永久空白。
        port.onDisconnect.addListener(() => {
          void fallbackHead();
          settle();
        });
        port.postMessage({ type: 'stream', text: head.text, pageContext: buildPageContext(head.el) });
        // 兜底超时：12s 内无完整响应则回退普通批，避免首段永久空白。
        setTimeout(() => {
          if (!settled) {
            void fallbackHead();
            settle();
          }
        }, 12_000);
      });
      // 尾段并发批量翻译，不等首段流式结束。
      let tailFailed = false;
      if (tail.length > 0) {
        translateChunk(tail, jobId).catch(() => {
          tailFailed = true;
        });
      }
      await headPromise;
      return tailFailed;
    }

    // ===== 整页翻译（沉浸式叠加层：译文贴在原文正下方，不改动原网页）=====
    async function translatePage(initial = true) {
      if (siteDisabled) {
        showSitePausedNotice();
        return;
      }
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
              const { el } = item;
              foundCount++;
              if (isInViewport(el)) visible.push(item);
              else deferred.push(item);
            }
            observeForLazyTranslation(deferred);
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
        const firstSet = new Set(firstChunk);
        firstChunk.forEach((item) => (item.el as HTMLElement).classList.add(PENDING_CLASS));
        let failures = 0;
        if (firstChunk.length > 0) {
          try {
            // 首块首段走流式输出（极低首字延迟），其余并行走普通批；任一失败不影响整体。
            const tailFailed = await translateFirstChunkStreamed(firstChunk, jobId);
            if (tailFailed) failures++;
          } catch {
            failures++;
          }
        }
        await scanPromise;
        if (activePageJobId !== jobId) return;
        // 扫描结束，foundCount 即本次预计总段数 → 进度分母变真实。
        totalSegCount = foundCount;
        if (foundCount === 0) {
          showStatus('未找到可翻译的文本内容', true);
          return;
        }

        // 首块（含已流式渲染的首段）不再二次翻译，仅处理其余可见段落。
        const remaining = visible.filter((item) => !firstSet.has(item));
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
          const savedText =
            estimatedTokensSaved > 0 ? `，本地约省 ${estimatedTokensSaved} Token` : '';
          showStatus(`无需翻译（内容已为目标语言）${savedText}`, true);
        } else {
          showProgress(false);
        }
      } catch (e: any) {
        showNotice(e?.message || '翻译失败', jobId || 'page-translation');
      } finally {
        // 取消后用户可能已经开始了新任务。旧任务的异步收尾不能清掉新任务的
        // busy / 按钮状态，也不能替新任务提前启动动态监听。
        if (activePageJobId === jobId) {
          busy = false;
          setToolbarLoading(false);
          if (initial) startDynamicTranslation();
        }
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
        if (
          !root.isConnected ||
          root.closest(
            '#ot-error-modal, .ot-translation, .ot-img-panel, .ot-img-seg, #ot-toolbar, #ot-settings-popover, #ot-status, .ot-selbtn',
          )
        )
          return;
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
          const compact = roots.filter(
            (root, index) =>
              !roots.some((other, otherIndex) => otherIndex !== index && other.contains(root)),
          );
          compact.forEach(queue);
        }, 80);
      };

      const scheduleControlledRoots = (control: Element) => {
        const ids =
          `${control.getAttribute('aria-controls') || ''} ${control.getAttribute('aria-owns') || ''}`
            .split(/\s+/)
            .filter(Boolean);
        ids.forEach((id) => {
          const controlled = document.getElementById(id);
          if (controlled) scheduleRoot(controlled);
        });
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
          .filter(
            (name) =>
              name !== PENDING_CLASS && name !== OBSERVED_CLASS && name !== TRANSLATED_CLASS,
          )
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
            if (
              target.closest(
                '#ot-error-modal, .ot-translation, .ot-img-panel, .ot-img-seg, #ot-toolbar, #ot-settings-popover, #ot-status, .ot-selbtn',
              )
            )
              continue;
            if (
              m.attributeName === 'class' &&
              normalizedSiteClasses(m.oldValue) ===
                normalizedSiteClasses(target.getAttribute('class'))
            )
              continue;
            scheduleRoot(target);
            if (
              m.attributeName === 'aria-expanded' ||
              m.attributeName === 'aria-controls' ||
              m.attributeName === 'aria-owns'
            ) {
              scheduleControlledRoots(target);
            }
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
              el.id === 'ot-toolbar' ||
              el.id === 'ot-settings-popover'
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
        attributeFilter: [
          'class',
          'style',
          'hidden',
          'open',
          'inert',
          'aria-hidden',
          'aria-expanded',
          'aria-controls',
          'aria-owns',
          'data-state',
        ],
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
          const roots = [root];
          const control = root.closest('[aria-controls], [aria-owns]');
          if (control) {
            const ids =
              `${control.getAttribute('aria-controls') || ''} ${control.getAttribute('aria-owns') || ''}`
                .split(/\s+/)
                .filter(Boolean);
            ids.forEach((id) => {
              const controlled = document.getElementById(id);
              if (controlled && !roots.includes(controlled)) roots.push(controlled);
            });
          }
          const newFound: TranslationItem[] = [];
          for (const scanRoot of roots) {
            const blocks = collectTextBlocks(scanRoot, Math.max(0, 200 - newFound.length));
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
              if (
                el.closest(
                  '.ot-translation, .ot-img-panel, .ot-toolbar, #ot-toolbar, #ot-settings-popover, #ot-status, .ot-selbtn',
                )
              )
                continue;
              newFound.push({ el, text: txt });
            }
            if (newFound.length >= 200) break;
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

    function setSiteDisabledState(disabled: boolean) {
      const changed = !sitePolicyLoaded || siteDisabled !== disabled;
      sitePolicyLoaded = true;
      siteDisabled = disabled;
      if (!changed) return;
      if (disabled) {
        clearTranslations();
        busy = false;
        setToolbarLoading(false);
        hideSelectionUi();
        closeNotice();
        closeSettingsPopover();
        document.getElementById('ot-toolbar')?.remove();
      } else {
        mountToolbar();
      }
    }

    function showSitePausedNotice() {
      showNotice('当前网站已暂停翻译，请在扩展弹窗中恢复', `site-policy-${randomId()}`);
    }

    // ---- 划词翻译：结果留在独立浮层中，不改写正文，也不会覆盖整段译文。 ----
    type SelectionSnapshot = { text: string; rect: DOMRect };
    let selectionHost: HTMLDivElement | null = null;
    let selectionPinned = false;
    let selectionTimer: ReturnType<typeof setTimeout> | null = null;
    let selectionRequestId = 0;
    let activeSelectionJobId: string | null = null;

    function hideSelectionUi() {
      selectionRequestId++;
      if (activeSelectionJobId) {
        sendRuntimeMessage({
          type: 'CANCEL_TRANSLATION',
          payload: { jobId: activeSelectionJobId },
        }).catch(() => {});
        activeSelectionJobId = null;
      }
      selectionHost?.remove();
      selectionHost = null;
      selectionPinned = false;
    }

    function captureSelection(): SelectionSnapshot | null {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
      const text = selection.toString().replace(/\s+/g, ' ').trim();
      if (!text) return null;
      const range = selection.getRangeAt(0);
      const start =
        range.startContainer.nodeType === Node.TEXT_NODE
          ? range.startContainer.parentElement
          : (range.startContainer as Element);
      if (
        !start ||
        start.closest('#ot-selection-ui, #ot-error-modal, .ot-translation, #ot-toolbar, #ot-settings-popover, #ot-status')
      ) {
        return null;
      }
      const root = start.getRootNode();
      if (root instanceof ShadowRoot && root.host.matches('#ot-selection-ui, .ot-translation'))
        return null;
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
      const top =
        below + estimatedHeight <= window.innerHeight - 8
          ? below
          : Math.max(8, rect.top - estimatedHeight - 8);
      host.style.setProperty('left', `${left}px`, 'important');
      host.style.setProperty('top', `${top}px`, 'important');
      requestAnimationFrame(() => {
        if (!host.isConnected) return;
        const box = host.getBoundingClientRect();
        if (box.right > window.innerWidth - 8) {
          host.style.setProperty(
            'left',
            `${Math.max(8, window.innerWidth - box.width - 8)}px`,
            'important',
          );
        }
        if (box.bottom > window.innerHeight - 8) {
          host.style.setProperty('top', `${Math.max(8, rect.top - box.height - 8)}px`, 'important');
        }
      });
    }

    function createSelectionHost(): HTMLDivElement {
      hideSelectionUi();
      const host = document.createElement('div');
      host.id = 'ot-selection-ui';
      host.className = 'ot-selbtn';
      host.dataset.haofanUi = 'true';
      host.style.setProperty('all', 'initial', 'important');
      host.style.setProperty('position', 'fixed', 'important');
      host.style.setProperty('z-index', '2147483647', 'important');
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.appendChild(createSelectionUiStyle());
      document.documentElement.appendChild(host);
      selectionHost = host;
      return host;
    }

    function renderSelectionPanel(
      host: HTMLDivElement,
      snapshot: SelectionSnapshot,
      translation?: string,
    ) {
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
      source.textContent =
        snapshot.text.length > 180 ? `${snapshot.text.slice(0, 180)}…` : snapshot.text;
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
            setTimeout(() => {
              if (copy.isConnected) copy.textContent = '复制';
            }, 1200);
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
      const jobId = randomId();
      activeSelectionJobId = jobId;
      try {
        const res: any = await sendRuntimeMessage({
          type: 'TRANSLATE_ONE',
          payload: { text: snapshot.text, jobId, pageContext: { title: document.title } },
        });
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
      } finally {
        if (activeSelectionJobId === jobId) activeSelectionJobId = null;
      }
    }

    function showSelectionUi(snapshot: SelectionSnapshot, translateImmediately = false) {
      if (siteDisabled) return;
      const host = createSelectionHost();
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
      if (siteDisabled) {
        hideSelectionUi();
        return;
      }
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
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (selectionHost && !event.composedPath().includes(selectionHost)) hideSelectionUi();
      },
      true,
    );
    window.addEventListener(
      'scroll',
      () => {
        if (!selectionPinned) hideSelectionUi();
      },
      true,
    );

    // 接收来自 background 的指令
    runtime.onMessage.addListener((msg: any) => {
      if (msg?.type === 'SITE_POLICY_CHANGED' && typeof msg.payload?.disabled === 'boolean') {
        sitePolicyRevision++;
        setSiteDisabledState(msg.payload.disabled);
      } else if (msg?.type === 'TRANSLATE_PAGE') {
        void sitePolicyReady.then(() =>
          siteDisabled ? showSitePausedNotice() : translatePage(true),
        );
      } else if (msg?.type === 'SHOW_IMAGE_RESULT') {
        if (siteDisabled) showSitePausedNotice();
        else showImageResult(msg.payload?.srcUrl, msg.payload?.result);
      } else if (msg?.type === 'SHOW_ERROR') {
        showNotice(msg.payload?.message || '操作失败', `external-${randomId()}`);
      } else if (msg?.type === 'TRANSLATE_SELECTION') {
        void sitePolicyReady.then(() => {
          if (siteDisabled) {
            showSitePausedNotice();
            return;
          }
          const snapshot = captureSelection();
          if (snapshot) showSelectionUi(snapshot, true);
        });
      }
    });

    // ============================================================
    // ★ 悬浮工具按钮 — 彻底重构：确保在任何网页上都可见
    // ============================================================
    // ===== 悬浮工具栏：可拖拽的 [译 + ⚙] 按钮组，⚙ 打开页面内快速设置 =====
    let settingsPopover: HTMLElement | null = null;
    let justDragged = false;
    // 快速设置浮层内表单样式（复用 Options 页 .ot-form* 规则，注入到 Shadow DOM 隔离）。
    const FORM_CSS = `
      :host { color-scheme: light dark; }
      * { box-sizing: border-box; }
      .sp-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid #d2d2d7; background: #f8f9fa; }
      .sp-head button { width: 28px; height: 28px; border: 0; background: transparent; color: #5f6368; font-size: 20px; line-height: 1; border-radius: 6px; cursor: pointer; }
      .sp-head button:hover { background: rgba(60,64,67,.08); color: #202124; }
      .sp-body { padding: 4px 14px 14px; overflow: auto; }
      .ot-form { margin: 0; }
      .ot-form.is-loading { opacity: .62; cursor: wait; }
      .ot-form-section { padding: 14px 0; border-bottom: 1px solid #d2d2d7; }
      .ot-form-section:last-of-type { border-bottom: 0; }
      .ot-form-section h2 { margin: 0 0 11px; color: #1d1d1f; font-size: 13px; font-weight: 650; }
      .ot-field-grid { display: grid; grid-template-columns: 1fr; gap: 11px; }
      .ot-field { display: flex; min-width: 0; flex-direction: column; gap: 7px; color: #6e6e73; font-size: 13px; font-weight: 600; }
      .ot-field > span { color: #86868b; font-size: 12px; font-weight: 400; }
      .ot-field-wide { grid-column: auto; }
      .ot-form input, .ot-form select, .ot-form textarea { width: 100%; min-width: 0; border: 1px solid #d2d2d7; border-radius: 10px; background: #fff; color: #1d1d1f; font-size: 13px; font-weight: 400; }
      .ot-form input, .ot-form select { min-height: 36px; padding: 8px 11px; }
      .ot-form textarea { min-height: 64px; padding: 10px 11px; line-height: 1.5; resize: vertical; }
      .ot-form input:focus, .ot-form select:focus, .ot-form textarea:focus { border-color: #0071e3; box-shadow: 0 0 0 3px rgba(26,115,232,.12); outline: none; }
      .ot-form input:read-only { background: #f2f2f7; color: #86868b; }
      .ot-check { display: flex; align-items: center; gap: 12px; min-height: 52px; margin: 0; color: #1d1d1f; cursor: pointer; }
      .ot-check input { width: 18px; min-height: 18px; height: 18px; margin: 0; padding: 0; flex: 0 0 auto; accent-color: #0071e3; }
      .ot-check span, .ot-check strong, .ot-check small { display: block; }
      .ot-check strong { font-size: 14px; font-weight: 600; }
      .ot-check small { margin-top: 3px; color: #86868b; font-size: 12px; font-weight: 400; line-height: 1.4; }
      .ot-advanced { padding: 8px 0; border-bottom: 1px solid #d2d2d7; }
      .ot-advanced summary { color: #1d1d1f; font-size: 13px; font-weight: 650; cursor: pointer; }
      .ot-advanced[open] summary { margin-bottom: 10px; }
      .ot-form-actions { display: flex; align-items: center; gap: 14px; min-height: 48px; padding-top: 12px; }
      .ot-test-btn { flex: 0 0 auto; min-height: 36px; padding: 8px 14px; border: 1px solid #d2d2d7; border-radius: 10px; background: #fff; color: #0071e3; font-size: 13px; font-weight: 650; cursor: pointer; }
      .ot-test-btn:hover { background: #f2f2f7; }
      .ot-test-btn:disabled { opacity: .58; cursor: progress; }
      .ot-status { min-width: 0; color: #248a3d; font-size: 12px; line-height: 1.5; }
      .ot-status.is-error { color: #c93434; }
      @media (prefers-color-scheme: dark) {
        :host { --text:#f0f6fc; }
        .sp-head { background: #161b22; border-color: #30363d; }
        .sp-body, .ot-form-section, .ot-advanced, .ot-form input, .ot-form select, .ot-form textarea, .ot-test-btn { background:#161b22; border-color:#30363d; color:#f0f6fc; }
        .ot-form-section h2, .ot-check strong, .ot-advanced summary { color:#f0f6fc; }
        .ot-field, .ot-check small { color:#9da7b3; }
        .ot-test-btn { color:#58a6ff; }
      }
    `;

    function closeSettingsPopover() {
      settingsPopover?.remove();
      settingsPopover = null;
      document.removeEventListener('pointerdown', onSettingsOutside, true);
      document.removeEventListener('keydown', onSettingsKey, true);
    }
    function onSettingsOutside(e: Event) {
      if (settingsPopover && !e.composedPath().includes(settingsPopover)) closeSettingsPopover();
    }
    function onSettingsKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeSettingsPopover();
    }
    function toggleSettingsPopover() {
      if (settingsPopover) {
        closeSettingsPopover();
        return;
      }
      const toolbar = document.getElementById('ot-toolbar');
      if (!toolbar) return;
      const pop = document.createElement('div');
      pop.id = 'ot-settings-popover';
      pop.dataset.haofanUi = 'true';
      Object.assign(pop.style, {
        position: 'fixed',
        zIndex: '2147483646',
        width: '320px',
        maxHeight: '70vh',
        display: 'flex',
        flexDirection: 'column',
        background: '#fff',
        color: '#1d1d1f',
        border: '1px solid #d2d2d7',
        borderRadius: '12px',
        boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
        overflow: 'hidden',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      });
      const shadow = pop.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = FORM_CSS;
      const head = document.createElement('div');
      head.className = 'sp-head';
      const title = document.createElement('div');
      title.textContent = '快速设置';
      title.style.fontWeight = '650';
      title.style.fontSize = '14px';
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.textContent = '×';
      closeBtn.title = '关闭';
      closeBtn.setAttribute('aria-label', '关闭快速设置');
      closeBtn.addEventListener('click', closeSettingsPopover);
      head.append(title, closeBtn);
      const body = document.createElement('div');
      body.className = 'sp-body';
      shadow.append(style, head, body);
      // 复用 Options/Popup 共用配置表单；compact=true 隐藏提示文案，改动即时写入并生效。
      buildConfigForm(body, true);
      document.documentElement.appendChild(pop);
      // 紧贴工具栏上方，越界则翻到下方。
      const pr = pop.getBoundingClientRect();
      const tr = toolbar.getBoundingClientRect();
      let left = tr.left + tr.width - pr.width;
      let top = tr.top - pr.height - 12;
      if (top < 8) top = tr.bottom + 12;
      if (left < 8) left = 8;
      if (left + pr.width > window.innerWidth - 8) left = window.innerWidth - pr.width - 8;
      pop.style.left = `${Math.max(8, left)}px`;
      pop.style.top = `${Math.max(8, top)}px`;
      settingsPopover = pop;
      setTimeout(() => {
        document.addEventListener('pointerdown', onSettingsOutside, true);
        document.addEventListener('keydown', onSettingsKey, true);
      }, 0);
    }

    function mountToolbar() {
      if (!sitePolicyLoaded || siteDisabled) return;
      if (document.getElementById('ot-toolbar')) return;

      const container = document.createElement('div');
      container.id = 'ot-toolbar';
      container.dataset.haofanUi = 'true';
      Object.assign(container.style, {
        position: 'fixed',
        right: '20px',
        bottom: '20px',
        zIndex: '2147483647',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        userSelect: 'none',
        touchAction: 'none',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      });

      const translateBtn = document.createElement('button');
      translateBtn.type = 'button';
      translateBtn.id = 'ot-translate-btn';
      translateBtn.textContent = '译';
      translateBtn.title = '好翻 · 翻译本页';
      translateBtn.setAttribute('aria-label', '翻译当前网页');
      Object.assign(translateBtn.style, {
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
        border: 'none',
        padding: '0',
        lineHeight: '1',
        boxShadow: '0 2px 8px rgba(0,113,227,0.35), 0 8px 24px rgba(0,0,0,0.18)',
        transition: 'transform 0.15s ease, background 0.2s ease',
      });
      translateBtn.addEventListener('mouseenter', () => {
        translateBtn.style.background = '#1765cc';
        translateBtn.style.transform = 'translateY(-2px)';
      });
      translateBtn.addEventListener('mouseleave', () => {
        translateBtn.style.background = '#1a73e8';
        translateBtn.style.transform = 'translateY(0)';
      });
      translateBtn.addEventListener('click', () => {
        if (justDragged) {
          justDragged = false;
          return;
        }
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

      const gearBtn = document.createElement('button');
      gearBtn.type = 'button';
      gearBtn.id = 'ot-settings-btn';
      gearBtn.textContent = '⚙';
      gearBtn.title = '快速设置';
      gearBtn.setAttribute('aria-label', '快速设置');
      Object.assign(gearBtn.style, {
        width: '36px',
        height: '36px',
        borderRadius: '50%',
        background: 'rgba(28,28,30,0.86)',
        color: '#fff',
        fontSize: '17px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        border: 'none',
        padding: '0',
        lineHeight: '1',
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        transition: 'transform 0.15s ease, background 0.2s ease',
      });
      gearBtn.addEventListener('mouseenter', () => {
        gearBtn.style.background = '#000';
      });
      gearBtn.addEventListener('mouseleave', () => {
        gearBtn.style.background = 'rgba(28,28,30,0.86)';
      });
      gearBtn.addEventListener('click', () => {
        if (justDragged) {
          justDragged = false;
          return;
        }
        toggleSettingsPopover();
      });

      container.append(gearBtn, translateBtn);

      // 拖拽：按住工具栏（含按钮）即可移动，点击按钮不触发移动。
      let dragging = false;
      let startX = 0;
      let startY = 0;
      let originLeft = 0;
      let originTop = 0;
      container.addEventListener('pointerdown', (e: PointerEvent) => {
        dragging = true;
        justDragged = false;
        const rect = container.getBoundingClientRect();
        originLeft = rect.left;
        originTop = rect.top;
        startX = e.clientX;
        startY = e.clientY;
        // 拖拽期间改用 left/top 定位，便于跟随指针。
        container.style.left = `${rect.left}px`;
        container.style.top = `${rect.top}px`;
        container.style.right = 'auto';
        container.style.bottom = 'auto';
        try {
          container.setPointerCapture(e.pointerId);
        } catch {
          /* 某些环境不支持指针捕获，拖拽仍可用 */
        }
      });
      container.addEventListener('pointermove', (e: PointerEvent) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) justDragged = true;
        const nl = Math.min(window.innerWidth - 40, Math.max(0, originLeft + dx));
        const nt = Math.min(window.innerHeight - 40, Math.max(0, originTop + dy));
        container.style.left = `${nl}px`;
        container.style.top = `${nt}px`;
      });
      container.addEventListener('pointerup', (e: PointerEvent) => {
        if (!dragging) return;
        dragging = false;
        try {
          container.releasePointerCapture(e.pointerId);
        } catch {
          /* 忽略 */
        }
        if (justDragged) {
          // 拖拽结束后延迟复位标记，避免误触发按钮点击。
          setTimeout(() => {
            justDragged = false;
          }, 0);
          const rect = container.getBoundingClientRect();
          void toolbarPosItem.setValue({
            right: Math.max(0, window.innerWidth - rect.right),
            bottom: Math.max(0, window.innerHeight - rect.bottom),
          });
        }
      });

      // 恢复上次拖拽位置（null 表示默认右下角）。
      void toolbarPosItem.getValue().then((pos) => {
        if (!pos) return;
        container.style.right = `${Math.max(0, pos.right)}px`;
        container.style.bottom = `${Math.max(0, pos.bottom)}px`;
        container.style.left = 'auto';
        container.style.top = 'auto';
      });

      // 挂载到 documentElement（html 节点），避免页面 body 有 transform 时破坏 fixed 定位。
      try {
        document.documentElement.appendChild(container);
      } catch {
        // 极少数情况下 documentElement 不可写，退回 body
        (document.body || document.documentElement).appendChild(container);
      }
    }

    function setToolbarLoading(loading: boolean) {
      const btn = document.getElementById('ot-translate-btn');
      if (!btn) return;
      if (loading) {
        // 加载态同时作为取消按钮。
        btn.setAttribute('aria-busy', 'true');
        btn.setAttribute('aria-label', '取消当前翻译');
        btn.style.width = 'auto';
        btn.style.padding = '0 14px';
        btn.style.borderRadius = '22px';
        btn.style.fontSize = '13px';
        btn.style.background = '#8fb8ef';
        btn.style.cursor = 'progress';
        btn.textContent = '取消翻译';
        btn.title = '取消当前翻译';
      } else {
        btn.setAttribute('aria-busy', 'false');
        btn.setAttribute('aria-label', '翻译当前网页');
        btn.style.width = '44px';
        btn.style.padding = '0';
        btn.style.borderRadius = '50%';
        btn.style.fontSize = '16px';
        btn.style.background = '#1a73e8';
        btn.style.cursor = 'pointer';
        btn.textContent = '译';
        btn.title = '好翻 · 翻译本页';
      }
    }

    // SPA 自愈：toolbar 被页面 JS 移除时自动重建
    if (document.body) {
      new MutationObserver(() => {
        if (sitePolicyLoaded && !siteDisabled && !document.getElementById('ot-toolbar'))
          mountToolbar();
      }).observe(document.body, { childList: true });
    }
  },
});

// ===== 图片翻译结果浮层（实现见 utils/image-overlay.ts）=====
function showImageResult(srcUrl: string | undefined, result: any) {
  activeImageCleanup?.();
  activeImageCleanup = mountImageResultOverlay(srcUrl, result);
}
