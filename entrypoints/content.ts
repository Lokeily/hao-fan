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
import {
  configItem,
  disabledSitesItem,
  autoSitesItem,
  toolbarPosItem,
  settingsPanelPosItem,
  setupNoticeShownItem,
} from '../utils/storage.ts';
import {
  createTranslationNode,
  createNoticeHost,
  createSelectionUiStyle,
  createSettingsPanel,
  createHoverBubble,
  createInputTranslateButton,
  makeDraggable,
  themeColors,
} from '../utils/content-ui.ts';
import { mountImageResultOverlay } from '../utils/image-overlay.ts';
import { isRetryableTranslationError, NoticeCycleGate } from '../utils/notice-policy.ts';
import { SessionTranslationCache } from '../utils/session-translation-cache.ts';
import { randomId } from '../utils/id.ts';
import { isSiteDisabled, withSiteDisabled } from '../utils/site-policy.ts';
import { normalizeConfig, getProviderApiKey, type AppConfig } from '../utils/config.ts';
import { buildConfigForm } from '../utils/ui.ts';
// 设置页样式直接打包进内容脚本（?raw），完整设置面板无需 fetch 扩展资源。
import fullSettingsCss from '../styles/options.css?raw';
import { LANGUAGES } from '../utils/languages.ts';
import { PROVIDERS } from '../utils/providers.ts';
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
    let pageTotalFound = 0; // 本次整页扫描发现的段落总数（进度显示用）
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
    let currentTranslationStyle = 'plain';
    let currentTranslateMode: 'auto' | 'manual' = 'auto';
    let hoverTranslateEnabled = true;
    let inputTranslateEnabled = true;
    // 流式开关（设置页「边生成边显示」）：关掉后单条交互直接走普通请求，不再开长连接。
    let streamingEnabled = true;
    // 因缺少 API Key 被拦下过：等用户填好 Key 立刻自动接着翻，不用再点一次。
    let awaitingSetup = false;
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
      .then(async () => {
        // 自动翻译此站：站点在自动翻译列表且未被暂停时，页面加载后自动开始翻译。
        try {
          const autoSites = await autoSitesItem.getValue();
          // null（未配置）= 默认自动翻译此站；配置过则按列表判断
          const autoEnabled = autoSites === null || isSiteDisabled(autoSites, location.href);
          if (autoEnabled) {
            await new Promise<void>((resolve) => {
              if (sitePolicyLoaded) {
                resolve();
                return;
              }
              const timer = setInterval(() => {
                if (sitePolicyLoaded) {
                  clearInterval(timer);
                  resolve();
                }
              }, 60);
            });
            if (!siteDisabled && !document.querySelector('.ot-translation')) {
              void translatePage(true);
            }
          }
        } catch {
          /* 存储不可用时跳过自动翻译 */
        }
      })
      .catch(() => {
        if (!sitePolicyLoaded) setSiteDisabledState(false);
      });

    // 页面内的开关/弹层反复创建相同 DOM 时直接复用译文；配置变化后立即失效，
    // 避免把旧语言或旧模型的结果继续显示出来。
    try {
      configItem.watch((v) => {
        translationConfigRevision++;
        sessionTranslations.clear();
        if (v && typeof v.translationStyle === 'string') currentTranslationStyle = v.translationStyle;
        if (v && (v.translateMode === 'auto' || v.translateMode === 'manual')) currentTranslateMode = v.translateMode;
        hoverTranslateEnabled = v ? v.hoverTranslate !== false : true;
        inputTranslateEnabled = v ? v.inputTranslate !== false : true;
        streamingEnabled = v ? v.streaming !== false : true;
        document.querySelectorAll('.ot-translation').forEach((el) => {
          (el as HTMLElement).dataset.style = currentTranslationStyle;
        });
      });
      void configItem
        .getValue()
        .then((v) => {
          if (v && typeof v.translationStyle === 'string') currentTranslationStyle = v.translationStyle;
          if (v && (v.translateMode === 'auto' || v.translateMode === 'manual')) currentTranslateMode = v.translateMode;
          hoverTranslateEnabled = v ? v.hoverTranslate !== false : true;
          inputTranslateEnabled = v ? v.inputTranslate !== false : true;
          streamingEnabled = v ? v.streaming !== false : true;
        })
        .catch(() => {});
      // 双向同步：设置变化时刷新已打开的大面板与快速设置面板，保证两边状态一致。
      // 回调内任何异常都不允许影响内容脚本主流程。
      const safeWatch = (item: { watch?: (cb: (v: any) => void) => void }, cb: (v: any) => void) => {
        try {
          item.watch?.((v) => {
            try {
              cb(v);
            } catch {
              /* 面板刷新失败不影响翻译主流程 */
            }
          });
        } catch {
          /* storage 监听不可用时静默降级 */
        }
      };
      safeWatch(configItem, (v) => {
        if (!v) return;
        hoverTranslateEnabled = v.hoverTranslate !== false;
        inputTranslateEnabled = v.inputTranslate !== false;
        streamingEnabled = v.streaming !== false;
        // 刚在页内设置面板里填好 Key：直接接着把这页翻完，不用再点一次按钮。
        if (awaitingSetup && !providerNeedsSetup(normalizeConfig(v))) {
          awaitingSetup = false;
          closeNotice();
          if (!siteDisabled && !document.querySelector('.ot-translation')) void translatePage(true);
        }
        if (v.translateMode === 'auto' || v.translateMode === 'manual') currentTranslateMode = v.translateMode;
        fullSettingsFormApi?.update(v);
        settingsPanel?.update({
          targetLang: v.targetLang,
          provider: v.provider,
          hoverTranslate: v.hoverTranslate !== false,
          inputTranslate: v.inputTranslate !== false,
        });
      });
      safeWatch(disabledSitesItem, (sites) => {
        const paused = isSiteDisabled(sites, location.href);
        settingsPanel?.update({ sitePaused: paused });
        fullSettingsFormApi?.updateSiteState(undefined, paused);
      });
      safeWatch(autoSitesItem, (sites) => {
        const autoOn = sites === null || isSiteDisabled(sites, location.href);
        settingsPanel?.update({ autoTranslate: autoOn });
        fullSettingsFormApi?.updateSiteState(autoOn, undefined);
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

    // ===== 流式单条翻译（长连接端口）=====
    // MV3 的 sendMessage 只能一次性回结果，要「边生成边显示」必须走长连接：
    // 内容脚本连上后台 haofan-stream 端口 → 发 {type:'translate-one'} →
    // 后台逐帧回 {id,delta}（delta 是累计译文，直接覆盖显示即可）→ 结束回 {id,done,translation}。
    // 只用于「用户正在等」的单条交互（划词 / 悬停 / 点击段落 / 输入框）；
    // 整页翻译仍走 TRANSLATE_BATCH 一次请求译 N 段，比逐条流式省得多，不改。
    const STREAM_IDLE_TIMEOUT_MS = 15_000;
    type StreamResult = { translation: string; issue: string[] | null; savedTokens: number };
    type StreamPort = ReturnType<typeof runtime.connect>;
    type StreamWaiter = {
      port: StreamPort;
      onDelta: (partial: string) => void;
      resolve: (value: StreamResult) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout> | null;
    };
    let streamPort: StreamPort | null = null;
    let streamUnavailable = false;
    const streamWaiters = new Map<string, StreamWaiter>();

    // 空闲超时而非总超时：只要还在往外吐字就不算卡住，长文也能正常译完。
    function armStreamTimer(id: string, waiter: StreamWaiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.timer = setTimeout(() => {
        if (streamWaiters.delete(id)) waiter.reject(new Error('流式翻译响应超时'));
      }, STREAM_IDLE_TIMEOUT_MS);
    }

    function rejectPortWaiters(port: StreamPort, reason: string) {
      streamWaiters.forEach((waiter, id) => {
        if (waiter.port !== port) return;
        streamWaiters.delete(id);
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(new Error(reason));
      });
    }

    function handleStreamMessage(raw: unknown) {
      const msg = raw as
        | {
            id?: unknown;
            delta?: unknown;
            done?: unknown;
            translation?: unknown;
            issue?: unknown;
            error?: unknown;
            stats?: { estimatedTokensSaved?: unknown };
          }
        | null
        | undefined;
      if (!msg || typeof msg.id !== 'string') return;
      const waiter = streamWaiters.get(msg.id);
      if (!waiter) return;
      if (!msg.done) {
        if (typeof msg.delta !== 'string') return;
        armStreamTimer(msg.id, waiter);
        try {
          waiter.onDelta(msg.delta);
        } catch {
          /* 渲染增量失败不能中断整条流式请求 */
        }
        return;
      }
      if (waiter.timer) clearTimeout(waiter.timer);
      streamWaiters.delete(msg.id);
      if (typeof msg.error === 'string' && msg.error) {
        waiter.reject(new Error(msg.error));
        return;
      }
      waiter.resolve({
        translation: typeof msg.translation === 'string' ? msg.translation : '',
        issue: Array.isArray(msg.issue) ? (msg.issue as string[]) : null,
        savedTokens: Math.max(0, Number(msg.stats?.estimatedTokensSaved) || 0),
      });
    }

    function getStreamPort(): StreamPort | null {
      if (streamUnavailable) return null;
      if (streamPort) return streamPort;
      try {
        const port = (runtime as any).connect?.({ name: 'haofan-stream' }) as StreamPort | undefined;
        if (!port) {
          streamUnavailable = true;
          return null;
        }
        port.onMessage.addListener(handleStreamMessage);
        port.onDisconnect.addListener(() => {
          // 后台 Service Worker 被回收或扩展重载都会断开：置空后下次自动重连，
          // 断开时未完成的请求交由各调用方的普通请求回退兜底。
          if (streamPort === port) streamPort = null;
          rejectPortWaiters(port, '流式连接已断开');
        });
        streamPort = port;
        return port;
      } catch {
        // connect 抛错基本意味着扩展已更新 / 后台不可达，本页面不再重试端口。
        streamUnavailable = true;
        return null;
      }
    }

    // 返回 null 表示流式当前不可用（开关关闭或端口连不上），调用方应走普通请求。
    function streamTranslateOne(
      text: string,
      onDelta: (partial: string) => void,
      options?: { jobId?: string; context?: { title?: string; prev?: string } },
    ): Promise<StreamResult> | null {
      if (!streamingEnabled) return null;
      const port = getStreamPort();
      if (!port) return null;
      const id = randomId();
      return new Promise<StreamResult>((resolve, reject) => {
        const waiter: StreamWaiter = { port, onDelta, resolve, reject, timer: null };
        streamWaiters.set(id, waiter);
        armStreamTimer(id, waiter);
        try {
          port.postMessage({
            type: 'translate-one',
            id,
            text,
            jobId: options?.jobId,
            context: options?.context,
          });
        } catch (error) {
          if (waiter.timer) clearTimeout(waiter.timer);
          streamWaiters.delete(id);
          if (streamPort === port) streamPort = null;
          reject(error instanceof Error ? error : new Error('流式请求发送失败'));
        }
      });
    }

    // 单条翻译统一入口：能流式就流式（首字更快），流式不可用 / 超时 / 出错立即回退普通请求，
    // 回退后的最终译文会覆盖已经显示的增量，用户看不到中间失败。
    async function translateOneText(
      text: string,
      options?: {
        jobId?: string;
        context?: { title?: string; prev?: string };
        onDelta?: (partial: string) => void;
      },
    ): Promise<StreamResult> {
      if (options?.onDelta) {
        const streamed = streamTranslateOne(text, options.onDelta, options);
        if (streamed) {
          try {
            const result = await streamed;
            if (result.translation) return result;
          } catch {
            /* 落到下面的普通请求 */
          }
        }
      }
      const res: any = await sendRuntimeMessage({
        type: 'TRANSLATE_ONE',
        payload: { text, jobId: options?.jobId, context: options?.context },
      });
      if (!res?.ok) throw new Error(res?.error || '翻译失败');
      const translation = typeof res.translation === 'string' ? res.translation : '';
      if (!translation) throw new Error('翻译服务返回了空结果');
      return {
        translation,
        issue: Array.isArray(res.issue) ? (res.issue as string[]) : null,
        savedTokens: Math.max(0, Number(res.stats?.estimatedTokensSaved) || 0),
      };
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

    // ===== 首次使用引导 =====
    // 没填 API Key 时，原来的表现是：整页照常发请求 → 每个批次都失败 → 弹「请先在设置页填写
    // API Key」+ 状态栏报「N 个批次失败」。对新用户既劝退又浪费请求。
    // 现在改成：不发任何请求，直接给一张能一键进设置的引导卡，并且只打扰一次。
    function providerNeedsSetup(cfg: AppConfig): boolean {
      const provider = PROVIDERS.find((p) => p.id === cfg.provider);
      if (!provider) return true;
      if (!provider.needsKey) return false;
      return !getProviderApiKey(cfg).trim();
    }

    async function needsSetupNow(): Promise<boolean> {
      try {
        return providerNeedsSetup(normalizeConfig(await configItem.getValue()));
      } catch {
        // 读不到配置就不拦，交给原有的后台报错路径，避免误判导致无法翻译。
        return false;
      }
    }

    // 强制展示（用户主动点翻译）时忽略「只提示一次」，否则点了没反应更困惑。
    function showSetupGuide(force = false) {
      const open = () => {
        closeNotice();
        openFullSettingsPanel();
      };
      const render = () => {
        closeNotice();
        noticeHost = createNoticeHost(
          '还差一步就能开始翻译',
          '好翻直接调用你自己的大模型账号，不经过任何中转服务器。填入 API Key 后即可翻译本页；Key 只保存在本机浏览器里。',
          closeNotice,
          { label: '打开设置', onAction: open },
        );
        document.documentElement.appendChild(noticeHost);
      };
      if (force) {
        render();
        return;
      }
      void setupNoticeShownItem
        .getValue()
        .then((shown) => {
          if (shown) return;
          render();
          return setupNoticeShownItem.setValue(true);
        })
        .catch(() => {
          /* 存储不可用时不弹引导，避免每页反复打扰 */
        });
    }

    // 统一的无 Key 闸门：整页与单条交互（划词/悬停/点段落/输入框）共用。
    // 返回 true 表示已被拦下（引导卡已展示），调用方应直接返回、不再发任何请求。
    async function guardSetupGate(userInitiated = false): Promise<boolean> {
      if (!(await needsSetupNow())) return false;
      showSetupGuide(userInitiated);
      return true;
    }
    // 译文可编辑 → 术语自动学习：把原文与用户修改后的译文发给后台抽取术语并沉淀。
    function handleTranslationEdit(el: Element, newTranslation: string) {
      const node = translationNodes.get(el);
      const source = node?.dataset.source || textOfBlock(el);
      if (!source) return;
      sendRuntimeMessage({
        type: 'LEARN_TERM',
        payload: { source, edited: newTranslation },
      })
        .then((r: any) => {
          if (r?.ok && r.learned) showStatus('已学习该术语 ✓', true);
          else if (r?.ok && !r.learned) showStatus(r?.reason || '未发现可学习的术语调整', true);
          else showStatus(r?.error || '术语学习失败', true);
        })
        .catch(() => showStatus('术语学习失败', true));
    }

    // ===== 译文嵌入（网页嵌入对照方案）：直接在原文文字下方插入译文节点 =====
    // 节点构建见 utils/content-ui.ts 的 createTranslationNode。
    function insertTranslation(el: Element, translation: string, sourceText?: string) {
      const existing = translationNodes.get(el);
      if (existing?.isConnected) {
        const text = existing.shadowRoot?.querySelector('.text');
        if (text) {
          text.textContent = translation;
          // 移除流式占位脉冲动画（译文到达后不再闪烁）
          text.classList.remove('is-pending');
        }
        existing.dataset.translation = translation;
        existing.dataset.source = sourceText ?? existing.dataset.source ?? '';
        return;
      }
      const node = createTranslationNode(translation, el, {
        sourceText,
        onEdit: (next) => handleTranslationEdit(el, next),
        style: currentTranslationStyle,
      });
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
      // float 元素与 CSS 多列（column-count/width）布局：afterend 插入的兄弟节点
      // 会被 float 挤出容器，或作为新列项流入下一列——译文与原文视觉错位。
      // 一律嵌入原文块内部，译文紧随原文且不改变页面布局。
      const ownFloat = getComputedStyle(el).float;
      let columnAncestor = false;
      let depth = 0;
      for (let p = el.parentElement; p && p !== document.documentElement && depth < 3; p = p.parentElement) {
        depth++;
        const cs = getComputedStyle(p);
        if (cs.columnCount !== 'auto' || cs.columnWidth !== 'auto') {
          columnAncestor = true;
          break;
        }
      }
      if (parentCreatesLayout || ownFloat !== 'none' || columnAncestor) el.appendChild(node);
      else el.insertAdjacentElement('afterend', node);
    }

    // 流式中途失败时撤掉半截译文：宁可什么都不显示，也不留一句没译完的话在页面上。
    function dropTranslationNode(el: Element) {
      const node = translationNodes.get(el);
      node?.remove();
      translationNodes.delete(el);
    }

    function applyTranslation(
      el: Element,
      original: string,
      translation: string,
    ): 'inserted' | 'skipped' | 'stale' {
      if (!el.isConnected || textOfBlock(el) !== original) return 'stale';
      if (!translation || translation === original) {
        markTranslated(el);
        return 'skipped';
      }
      insertTranslation(el, translation, original);
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
    function progressText(): string {
      return pageTotalFound > 0 ? `${translatedCount}/${pageTotalFound}` : String(translatedCount);
    }

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
      pageTotalFound = 0;
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

    // 滑动窗口上下文：页面标题 + 上一段译文，供后台做上下文感知翻译。
    let lastTranslation = '';
    function pageContext(): { title?: string; prev?: string } {
      return { title: document.title || undefined, prev: lastTranslation || undefined };
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
          translateChunk(chunk, jobId, pageContext()),
        );
        if (activePageJobId === jobId) {
          const savedText = estimatedTokensSaved > 0 ? ` · 约省 ${estimatedTokensSaved} Token` : '';
          const failureText = failures > 0 ? ` · ${failures} 批失败` : '';
          showStatus(`已翻译 ${progressText()} 段${savedText}${failureText} · 滚动时继续`, true);
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
      context?: { title?: string; prev?: string },
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
              payload: { text: item.text, jobId, context },
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
            if (r.issue && Array.isArray(r.issue) && r.issue.length > 0) {
              const node = translationNodes.get(item.el);
              node?.setAttribute('data-quality', 'warn');
              node?.setAttribute('title', '质量自检：原文中的数字 / 链接 / 代码可能未完整保留，请核对');
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
      if (inserted > 0) showStatus(`翻译中… 已译 ${progressText()} 段`);
      if (failures > 0) {
        throw firstError instanceof Error ? firstError : new Error(`${failures} 段逐条翻译失败`);
      }
    }

    async function translateChunk(
      items: { el: Element; text: string }[],
      jobId?: string,
      context?: { title?: string; prev?: string },
    ) {
      if (jobId && (activePageJobId !== jobId || blockedPageJobId === jobId)) {
        items.forEach((item) => (item.el as HTMLElement).classList.remove(PENDING_CLASS));
        return;
      }
      const requestConfigRevision = translationConfigRevision;
      try {
        const texts = items.map((x) => x.text);
        const res = (await sendRuntimeMessage({
          type: 'TRANSLATE_BATCH',
          payload: { texts, jobId, context },
        })) as
          | {
              ok?: boolean;
              translations?: unknown;
              issues?: (string[] | null)[] | null;
              stats?: { estimatedTokensSaved?: number };
              error?: string;
            }
          | undefined;
        if (jobId && activePageJobId !== jobId) return;
        if (!res?.ok) throw new Error(res?.error || '翻译失败');
        const translations = res.translations;
        if (!Array.isArray(translations) || translations.length !== items.length) {
          // 批量响应条目数异常：逐条回退翻译，避免整页翻译被单批错误中断。
          await fallbackTranslateIndividually(items, jobId, context);
          return;
        }
        const saved = Number(res.stats?.estimatedTokensSaved) || 0;
        estimatedTokensSaved += Math.max(0, saved);
        // 更新上下文窗口：非流式批量完成后，以最后一段译文作为后续翻译的语境
        const lastText = items[items.length - 1];
        if (lastText && typeof translations[items.length - 1] === 'string' && translations[items.length - 1]) {
          lastTranslation = translations[items.length - 1];
        }

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
          // 质量自检发现原文符号缺失：标记该译文，提示用户核对。
          const issue = res.issues?.[k];
          if (issue && Array.isArray(issue) && issue.length > 0) {
            const node = translationNodes.get(x.el);
            node?.setAttribute('data-quality', 'warn');
            node?.setAttribute('title', '质量自检：原文中的数字 / 链接 / 代码可能未完整保留，请核对');
          }
          retryCounts.delete(x.el);
        });
        if (stale.length > 0 && (!jobId || activePageJobId === jobId)) {
          observeForLazyTranslation(stale);
        }
        translatedCount += inserted;
        if (inserted > 0) {
          const savedText = estimatedTokensSaved > 0 ? ` · 约省 ${estimatedTokensSaved} Token` : '';
          showStatus(`翻译中… 已译 ${progressText()} 段${savedText}`);
        }
      } catch (error) {
        if (jobId && activePageJobId !== jobId) return;
        const message = error instanceof Error ? error.message : '翻译失败';
        showNotice(message, jobId || 'page-translation');
        const canRetry = isRetryableTranslationError(error);
        if (!canRetry && jobId) blockedPageJobId = jobId;
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

    // ===== 整页翻译（沉浸式叠加层：译文贴在原文正下方，不改动原网页）=====
    async function translatePage(initial = true, userInitiated = false) {
      if (siteDisabled) {
        showSitePausedNotice();
        return;
      }
      if (busy) return;
      busy = true;

      // 引擎/Key 还没配好：一个请求都不发，直接给引导。
      // 用户主动点翻译时强制展示（点了没反应更困惑），自动翻译时只打扰一次。
      if (await needsSetupNow()) {
        busy = false;
        awaitingSetup = true;
        showSetupGuide(userInitiated);
        return;
      }

      // 手动模式：不做整页自动翻译，仅由「点击段落 / 划词」触发（省 Token，且不被无关内容打扰）。
      if (currentTranslateMode === 'manual') {
        busy = false;
        showStatus('手动模式：点击段落或划选文字即可翻译', true);
        return;
      }

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
              const { el } = item;
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
            // 首屏也走批量（1 个请求），不再逐条流式发请求：把重复的系统提示词
            // /术语/上下文前缀从「每屏 N 份」降到「1 份」，显著省 Token。
            await translateChunk(firstChunk, jobId, pageContext());
          } catch {
            failures++;
          }
        }
        await scanPromise;
        if (activePageJobId !== jobId) return;
        pageTotalFound = foundCount;
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
          translateChunk(chunk, jobId!, pageContext()),
        );
        if (activePageJobId !== jobId) return;

        if (failures > 0) {
          showStatus(`已翻译 ${progressText()} 段，${failures} 个批次失败`, true);
        } else if (translatedCount === 0) {
          const savedText =
            estimatedTokensSaved > 0 ? `，本地约省 ${estimatedTokensSaved} Token` : '';
          showStatus(`无需翻译（内容已为目标语言）${savedText}`, true);
        } else {
          const savedText = estimatedTokensSaved > 0 ? ` · 约省 ${estimatedTokensSaved} Token` : '';
          const lazyText = deferredCount > 0 ? ' · 滚动时继续' : '';
          showStatus(`已翻译 ${progressText()} 段${savedText}${lazyText}`, true);
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
      // 手动模式下不自动翻译动态新增内容，保持「按需翻译」。
      if (currentTranslateMode === 'manual') return;
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
        // 用户编辑并学习过的译文予以保留，避免 SPA 更新时被重新翻译覆盖。
        if (translation?.dataset.edited === 'true') {
          const classes = (element as HTMLElement).classList;
          classes?.remove(PENDING_CLASS, OBSERVED_CLASS);
          return;
        }
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
            '#ot-error-modal, .ot-translation, .ot-img-panel, .ot-img-seg, #ot-toolbar, #ot-status, .ot-selbtn',
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

      // ===== 动态重译节流 =====
      // 时钟、股价、倒计时、直播人数这类元素每秒都在改文字。原来只要 characterData 一变
      // 就立刻 release + 重译，等于每秒烧一次 Token。这里两道闸：
      //   ① 只有数字/空白在变 → 直接把译文里的数字就地换掉，0 请求；
      //   ② 其余变化 → 每个元素 8 秒内最多重译一次，冷却期内的抖动合并成一次。
      const RETRANSLATE_COOLDOWN_MS = 8_000;
      const lastRetranslateAt = new WeakMap<Element, number>();
      const cooldownQueue = new Set<Element>();
      let cooldownTimer: ReturnType<typeof setTimeout> | null = null;

      // 抹掉数字与数字周边符号后的「文字骨架」：骨架相同即认为句子没变，只是数值在动。
      const digitSkeleton = (text: string) =>
        text
          .replace(/[\d\s.,:%+\-/]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

      // 把译文里的旧数字按出现顺序替换成新数字。任何一处对不上就整体放弃，
      // 宁可继续显示旧译文，也绝不拼出错误的数字。
      const patchTranslationNumbers = (
        node: HTMLSpanElement,
        prev: string,
        next: string,
      ): boolean => {
        const before = prev.match(/\d+/g) || [];
        const after = next.match(/\d+/g) || [];
        if (before.length !== after.length) return false;
        if (before.length === 0) {
          node.dataset.source = next;
          return true;
        }
        const textEl = node.shadowRoot?.querySelector('.text');
        const current = textEl?.textContent || '';
        if (!current) return false;
        let cursor = 0;
        let out = '';
        for (let i = 0; i < before.length; i++) {
          const at = current.indexOf(before[i], cursor);
          if (at < 0) return false;
          out += current.slice(cursor, at) + after[i];
          cursor = at + before[i].length;
        }
        out += current.slice(cursor);
        textEl!.textContent = out;
        node.dataset.translation = out;
        node.dataset.source = next;
        return true;
      };

      const flushCooldownQueue = () => {
        cooldownTimer = null;
        const pending = Array.from(cooldownQueue);
        cooldownQueue.clear();
        pending.forEach((anchor) => {
          if (anchor.isConnected) refreshChangedText(anchor);
        });
      };

      const queueAfterCooldown = (anchor: Element, waitMs: number) => {
        cooldownQueue.add(anchor);
        if (cooldownTimer) return;
        cooldownTimer = setTimeout(flushCooldownQueue, Math.max(200, waitMs));
      };

      const refreshChangedText = (element: Element) => {
        const anchor = closestTextBlock(element, true);
        if (!anchor) return;
        const node = translationNodes.get(anchor);
        const prev = node?.dataset.source || '';
        const next = textOfBlock(anchor);
        if (prev && prev === next) return;
        // ① 只有数字在动：就地改数，不发请求。
        if (node?.isConnected && prev && next && digitSkeleton(prev) === digitSkeleton(next)) {
          if (patchTranslationNumbers(node, prev, next)) return;
        }
        // ② 冷却：同一元素 8 秒内的反复变化只在冷却结束后按「最终文本」译一次。
        const now = Date.now();
        const last = lastRetranslateAt.get(anchor) ?? 0;
        const elapsed = now - last;
        if (elapsed < RETRANSLATE_COOLDOWN_MS) {
          queueAfterCooldown(anchor, RETRANSLATE_COOLDOWN_MS - elapsed);
          return;
        }
        lastRetranslateAt.set(anchor, now);
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
                '#ot-error-modal, .ot-translation, .ot-img-panel, .ot-img-seg, #ot-toolbar, #ot-status, .ot-selbtn',
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
                  '.ot-translation, .ot-img-panel, .ot-toolbar, #ot-toolbar, #ot-status, .ot-selbtn',
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
        closeSettingsPanel();
        closeFullSettings();
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
        start.closest('#ot-selection-ui, #ot-error-modal, .ot-translation, #ot-toolbar, #ot-status')
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

    // 流式增量只改结果文字，不重建整个面板——重建会让原文与复制按钮跟着闪。
    function updateSelectionResultText(host: HTMLDivElement, partial: string) {
      if (!partial) return;
      const result = host.shadowRoot?.querySelector('.result');
      if (!result) return;
      result.classList.remove('loading');
      result.textContent = partial;
    }

    async function translateSelectionInPopover(
      snapshot: SelectionSnapshot,
      host: HTMLDivElement,
      operationId = `selection-${randomId()}`,
    ) {
      // 未配置 Key：不发起请求，直接给引导（用户主动点译 → 强制展示）。
      if (await guardSetupGate(true)) {
        hideSelectionUi();
        return;
      }
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
        const res = await translateOneText(snapshot.text, {
          jobId,
          onDelta: (partial) => {
            if (requestId !== selectionRequestId || host !== selectionHost) return;
            updateSelectionResultText(host, partial);
          },
        });
        if (requestId !== selectionRequestId || host !== selectionHost) return;
        const translation = res.translation;
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

    // ===== 手动模式：点击段落即翻译该块（不整页自动翻）=====
    async function manualTranslateBlock(el: Element): Promise<void> {
      // 未配置 Key：不发起请求，直接给引导。
      if (await guardSetupGate(true)) return;
      const html = el as HTMLElement;
      if (
        html.classList.contains(TRANSLATED_CLASS) ||
        html.classList.contains(PENDING_CLASS) ||
        html.classList.contains(OBSERVED_CLASS)
      )
        return;
      if (html.querySelector(':scope > .ot-translation')) return;
      const text = textOfBlock(el);
      if (text.length < 2) return;
      html.classList.add(PENDING_CLASS);
      let streamedPartial = false;
      try {
        const r = await translateOneText(text, {
          onDelta: (partial) => {
            // 增量先占位显示，最终译文到达后由 applyTranslation 覆盖并标记完成。
            if (!partial || !el.isConnected) return;
            streamedPartial = true;
            insertTranslation(el, partial, text);
          },
        });
        sessionTranslations.remember(text, r.translation);
        applyTranslation(el, text, r.translation);
        estimatedTokensSaved += r.savedTokens;
      } catch {
        /* 翻译失败静默，不阻断交互；但半截译文必须撤掉 */
        if (streamedPartial) dropTranslationNode(el);
      } finally {
        html.classList.remove(PENDING_CLASS);
      }
    }

    // 手动模式下：点击正文段落触发翻译；有划词选区时不干扰选区。
    document.addEventListener(
      'click',
      (e: Event) => {
        if (currentTranslateMode !== 'manual' || siteDisabled) return;
        const target = e.target as Element | null;
        if (!target) return;
        if (
          target.closest(
            '.ot-translation, #ot-toolbar, #ot-status, #ot-settings-panel, #ot-selection-ui, .ot-selbtn',
          )
        )
          return;
        if (!window.getSelection()?.isCollapsed) return;
        const el = closestTextBlock(target, true);
        if (el) void manualTranslateBlock(el);
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
          siteDisabled ? showSitePausedNotice() : translatePage(true, true),
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
    // ===== 悬浮工具按钮组（可拖动）：译 + 设置入口 =====
    let settingsPanel: ReturnType<typeof createSettingsPanel> | null = null;
    // 设置写入串行队列：多入口（快速面板/大面板/自动翻译）并发写入时防止
    // "读旧值-写新值"互相覆盖（竞态）。
    let settingsWriteQueue: Promise<void> = Promise.resolve();
    const enqueueSettingsWrite = (task: () => Promise<void>): void => {
      settingsWriteQueue = settingsWriteQueue.then(task).catch(() => {});
    };

    function closeSettingsPanel() {
      settingsPanel?.host.remove();
      settingsPanel = null;
    }

    // ===== 页面内完整设置大面板（网页中央弹窗） =====
    let fullSettingsHost: HTMLElement | null = null;
    let fullSettingsFormApi: ReturnType<typeof buildConfigForm> | null = null;
    let fullSettingsEsc: ((e: KeyboardEvent) => void) | null = null;
    let fullSettingsWheelLock: ((e: WheelEvent) => void) | null = null;
    let fullSettingsTouchLock: ((e: TouchEvent) => void) | null = null;

    function closeFullSettings() {
      if (fullSettingsEsc) {
        document.removeEventListener('keydown', fullSettingsEsc, true);
        fullSettingsEsc = null;
      }
      if (fullSettingsWheelLock) {
        window.removeEventListener('wheel', fullSettingsWheelLock, true);
        fullSettingsWheelLock = null;
      }
      if (fullSettingsTouchLock) {
        window.removeEventListener('touchmove', fullSettingsTouchLock, true);
        fullSettingsTouchLock = null;
      }
      fullSettingsHost?.remove();
      fullSettingsHost = null;
      fullSettingsFormApi = null;
    }

    function openFullSettingsPanel() {
      closeSettingsPanel();
      closeFullSettings();
      const theme = themeColors();
      const dark = theme.text === '#f5f5f7';
      // 遮罩层：全屏半透明 + 背景模糊，点击空白处关闭
      const host = document.createElement('div');
      host.id = 'ot-full-settings';
      host.dataset.haofanUi = 'true';
      host.style.setProperty('all', 'initial', 'important');
      host.style.setProperty('position', 'fixed', 'important');
      host.style.setProperty('inset', '0', 'important');
      host.style.setProperty('z-index', '2147483646', 'important');
      host.style.setProperty('background', dark ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.45)', 'important');
      host.style.setProperty('backdrop-filter', 'blur(12px) saturate(110%)', 'important');
      host.style.setProperty('-webkit-backdrop-filter', 'blur(12px) saturate(110%)', 'important');
      host.style.setProperty('display', 'flex', 'important');
      host.style.setProperty('align-items', 'center', 'important');
      host.style.setProperty('justify-content', 'center', 'important');
      host.style.setProperty('animation', 'ot-modal-fade 0.18s ease', 'important');

      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `
        :host { color-scheme: light dark; }
        * { box-sizing: border-box; }
        @keyframes ot-modal-fade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes ot-modal-pop {
          from { opacity: 0; transform: scale(0.96) translateY(10px); }
          to { opacity: 1; transform: none; }
        }
        .modal {
          display: flex; flex-direction: column;
          width: min(640px, calc(100vw - 48px));
          height: min(74vh, 700px);
          max-height: calc(100vh - 48px);
          border-radius: 20px;
          background: ${theme.surface};
          color: ${theme.text};
          border: 1px solid ${theme.border};
          box-shadow: 0 8px 24px rgba(0,0,0,0.18), 0 48px 120px rgba(0,0,0,0.45);
          overflow: hidden;
          animation: ot-modal-pop 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
        }
        .head {
          display: flex; align-items: center; gap: 8px;
          padding: 12px 16px;
          border-bottom: 1px solid ${theme.border};
          user-select: none;
        }
        .title { flex: 1; font-size: 15px; font-weight: 700; letter-spacing: 0; }
        .close {
          width: 30px; height: 30px; padding: 0;
          border: 0; border-radius: 9px;
          background: transparent; color: ${theme.text2};
          font-size: 20px; line-height: 1; cursor: pointer;
        }
        .close:hover { background: rgba(128,128,128,0.18); color: ${theme.text}; }
        .ot-full-settings-body {
          flex: 1; min-height: 0;
          overflow-y: auto;
          overscroll-behavior: contain;
          padding: 4px 20px 36px;
        }
        .foot {
          display: flex; align-items: center; justify-content: center; gap: 12px;
          padding: 10px 16px;
          border-top: 1px solid ${theme.border};
        }
        .foot-hint { color: ${theme.text2}; font-size: 11px; }
      `;
      const head = document.createElement('div');
      head.className = 'head';
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = '好翻 · 完整设置';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'close';
      close.textContent = '×';
      close.setAttribute('aria-label', '关闭完整设置');
      close.addEventListener('click', closeFullSettings);
      head.append(title, close);

      const body = document.createElement('div');
      body.className = 'ot-full-settings-body';
      const mount = document.createElement('div');
      body.appendChild(mount);
      const foot = document.createElement('div');
      foot.className = 'foot';
      const hint = document.createElement('span');
      hint.className = 'foot-hint';
      hint.textContent = '设置自动保存 · 快捷键 Alt+T 翻译当前网页';
      foot.appendChild(hint);
      // 关键：head/body/foot 必须包在 .modal 容器内——遮罩 host 是 flex 居中，
      // 直接平铺会把三者拉成水平一排（此前"排版一团糟"的根因）。
      const modal = document.createElement('div');
      modal.className = 'modal';
      modal.append(head, body, foot);
      shadow.append(style, modal);
      document.documentElement.appendChild(host);
      fullSettingsHost = host;

      // 点击遮罩空白处关闭；Esc 关闭。
      // 注意：不能用 e.target === host——Shadow DOM 事件重定向会把面板内部的
      // 点击目标重定向为 host，导致"点击输入框/下拉就关闭面板"。
      // composedPath() 返回真实目标（不重定向），用它判断点击是否落在面板外。
      host.addEventListener('pointerdown', (e) => {
        const path = e.composedPath();
        if (path[0] === host) closeFullSettings();
      });
      const escHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') closeFullSettings();
      };
      fullSettingsEsc = escHandler;
      document.addEventListener('keydown', escHandler, true);
      // 弹窗打开期间锁定页面滚动：滚轮/触摸落在面板外（遮罩上）时阻止，
      // 面板内部滚动不受影响（此前全局拦截导致面板内容也滚不动）。
      const inModal = (target: EventTarget | null) => {
        const el = target instanceof Element ? target : null;
        if (!el) return false;
        // 事件目标在面板 shadow 树内（含面板内部元素）→ 不拦截，面板可正常滚动
        return Boolean(shadow.contains(el));
      };
      fullSettingsWheelLock = (e: WheelEvent) => {
        if (!inModal(e.target)) e.preventDefault();
      };
      fullSettingsTouchLock = (e: TouchEvent) => {
        if (!inModal(e.target)) e.preventDefault();
      };
      window.addEventListener('wheel', fullSettingsWheelLock, true);
      window.addEventListener('touchmove', fullSettingsTouchLock, true);
      window.addEventListener(
        'pointerup',
        () => {},
        { once: true },
      );

      // 样式直接来自打包进内容脚本的 options.css（?raw），不依赖网络。
      const sheet = document.createElement('style');
      sheet.textContent = fullSettingsCss
        .replace(/:root/g, ':host')
        .replace(/\bbody\b/g, '.ot-full-settings-body');
      shadow.prepend(sheet);

      // 站点偏好初始状态
      void (async () => {
        const [disabledSites, autoSites] = await Promise.all([
          disabledSitesItem.getValue(),
          autoSitesItem.getValue(),
        ]);
        try {
          fullSettingsFormApi = buildConfigForm(mount, false, {
            host: location.host,
            autoTranslate: isSiteDisabled(autoSites, location.href),
            paused: isSiteDisabled(disabledSites, location.href),
            onAuto: (enabled) => {
              enqueueSettingsWrite(async () => {
                const sites = await autoSitesItem.getValue();
                await autoSitesItem.setValue(withSiteDisabled(sites, location.href, enabled));
              });
            },
            onPause: (paused) => {
              enqueueSettingsWrite(async () => {
                const sites = await disabledSitesItem.getValue();
                await disabledSitesItem.setValue(withSiteDisabled(sites, location.href, paused));
              });
            },
          });
        } catch {
          // 表单构建失败：面板保留头部与关闭按钮，不崩溃内容脚本
          mount.textContent = '设置加载失败，请重新打开';
          mount.style.cssText = 'padding:12px;font-size:13px;color:#ff3b30;';
        }
      })();
    }

    async function openSettingsPanel(anchorX: number, anchorY: number) {
      closeSettingsPanel();
      try {
        const cfg = normalizeConfig(await configItem.getValue());
        const [disabledSites, autoSites] = await Promise.all([
          disabledSitesItem.getValue(),
          autoSitesItem.getValue(),
        ]);
        const paused = isSiteDisabled(disabledSites, location.href);
        const autoOn = autoSites === null || isSiteDisabled(autoSites, location.href);
        const hoverOn = cfg.hoverTranslate !== false;
        const inputOn = cfg.inputTranslate !== false;
        let panelX = anchorX;
        let panelY = anchorY;
        try {
          const saved = await settingsPanelPosItem.getValue();
          if (saved) {
            panelX = saved.x;
            panelY = saved.y;
          }
        } catch {
          /* 无持久化位置时跟随锚点 */
        }
        settingsPanel = createSettingsPanel({
          languages: LANGUAGES.map((l) => l.name),
          providers: PROVIDERS.map((p) => ({ id: p.id, name: p.name, needsKey: p.needsKey })),
          targetLang: cfg.targetLang,
          provider: cfg.provider,
          sitePaused: paused,
          siteHost: location.host,
          autoTranslate: autoOn,
          hoverTranslate: hoverOn,
          inputTranslate: inputOn,
          onAutoToggle: (enabled) => {
            enqueueSettingsWrite(async () => {
              const sites = await autoSitesItem.getValue();
              await autoSitesItem.setValue(withSiteDisabled(sites, location.href, enabled));
            });
          },
          onHoverToggle: (enabled) => {
            enqueueSettingsWrite(async () => {
              const current = normalizeConfig(await configItem.getValue());
              await configItem.setValue({ ...current, hoverTranslate: enabled });
            });
          },
          onInputToggle: (enabled) => {
            enqueueSettingsWrite(async () => {
              const current = normalizeConfig(await configItem.getValue());
              await configItem.setValue({ ...current, inputTranslate: enabled });
            });
          },
          onTargetLang: (value) => {
            enqueueSettingsWrite(async () => {
              const current = normalizeConfig(await configItem.getValue());
              await configItem.setValue({ ...current, targetLang: value });
              translationConfigRevision++;
              sessionTranslations.clear();
            });
          },
          onProvider: (value) => {
            enqueueSettingsWrite(async () => {
              const provider = PROVIDERS.find((p) => p.id === value);
              if (!provider) return;
              const current = normalizeConfig(await configItem.getValue());
              await configItem.setValue({
                ...current,
                provider: value,
                baseUrl: provider.baseUrl,
                model: provider.defaultModel,
              });
              translationConfigRevision++;
              sessionTranslations.clear();
            });
          },
          onSiteToggle: (paused) => {
            enqueueSettingsWrite(async () => {
              const sites = await disabledSitesItem.getValue();
              await disabledSitesItem.setValue(withSiteDisabled(sites, location.href, paused));
            });
          },
          onOpenFullSettings: () => {
            closeSettingsPanel();
            openFullSettingsPanel();
          },
          onClose: closeSettingsPanel,
          onDrag: (x, y) => {
            void settingsPanelPosItem.setValue({ x, y }).catch(() => {});
          },
        });
        // 默认定位在齿轮上方（工具栏常驻右下角，放下方会超出视口）；
        // 上方放不下再放下方，最后按面板实际尺寸夹取在视口内。
        const panelW = settingsPanel.host.offsetWidth || 320;
        const panelH = settingsPanel.host.offsetHeight || 400;
        if (panelY + panelH > window.innerHeight - 8 && anchorY - panelH - 8 >= 8) {
          panelY = anchorY - panelH - 8;
        }
        const maxX = Math.max(8, window.innerWidth - panelW - 8);
        const maxY = Math.max(8, window.innerHeight - panelH - 8);
        settingsPanel.host.style.setProperty(
          'left',
          `${Math.min(Math.max(8, panelX), maxX)}px`,
          'important',
        );
        settingsPanel.host.style.setProperty(
          'top',
          `${Math.min(Math.max(8, panelY), maxY)}px`,
          'important',
        );
      } catch {
        /* 存储不可用时静默 */
      }
    }

    // ===== 悬停翻译：鼠标悬停段落 500ms 显示译文气泡（可固定） =====
    let hoverBubble: ReturnType<typeof createHoverBubble> | null = null;
    let hoverTimer: ReturnType<typeof setTimeout> | null = null;
    let hoverPinned = false;
    let hoverEl: Element | null = null;

    function hideHoverBubble() {
      if (hoverPinned) return;
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      }
      if (hoverHideTimer) {
        clearTimeout(hoverHideTimer);
        hoverHideTimer = null;
      }
      hoverBubble?.host.remove();
      hoverBubble = null;
      hoverEl = null;
    }

    async function showHoverBubbleFor(el: Element) {
      // 未配置 Key：不发起请求（悬停属被动触发，引导只弹一次）。
      if (await guardSetupGate()) return;
      if (hoverPinned) return;
      hideHoverBubble();
      hoverEl = el;
      const text = textOfBlock(el);
      if (text.length < 2) return;
      if (el.querySelector(':scope > .ot-translation')) return;
      hoverBubble = createHoverBubble(text, (pinned) => {
        hoverPinned = pinned;
      });
      document.documentElement.appendChild(hoverBubble.host);
      const rect = el.getBoundingClientRect();
      const bw = 280;
      const left = Math.min(Math.max(8, rect.left + 8), window.innerWidth - bw - 8);
      const top = Math.min(Math.max(8, rect.bottom + 8), window.innerHeight - 80);
      hoverBubble.host.style.setProperty('left', `${left}px`, 'important');
      hoverBubble.host.style.setProperty('top', `${top}px`, 'important');
      const cached = sessionTranslations.get(text);
      if (cached !== undefined) {
        hoverBubble.setTranslation(cached);
        return;
      }
      void translateOneText(text, {
        onDelta: (partial) => {
          if (!hoverBubble || hoverEl !== el || !partial) return;
          hoverBubble.setTranslation(partial);
        },
      })
        .then((r) => {
          if (!hoverBubble || hoverEl !== el) return;
          hoverBubble.setTranslation(r.translation);
          sessionTranslations.remember(text, r.translation);
          estimatedTokensSaved += r.savedTokens;
        })
        .catch((error) => {
          if (hoverBubble && hoverEl === el) {
            hoverBubble.setTranslation(error instanceof Error ? error.message : '翻译失败');
          }
        });
    }

    document.addEventListener(
      'mouseover',
      (e) => {
        if (!hoverTranslateEnabled) return;
        // 手动模式不自动悬停翻译，保持「按需翻译」。
        if (currentTranslateMode === 'manual') return;
        const target = e.target as Element | null;
        if (!target || !document.body.contains(target)) return;
        if (
          target.closest(
            '#ot-hover-bubble, #ot-toolbar, .ot-translation, .ot-selbtn, #ot-error-modal, #ot-settings-panel, #ot-input-btn, #ot-input-result',
          )
        )
          return;
        if (target.closest('a, button, input, textarea, select, [contenteditable]')) return;
        const el = closestTextBlock(target, true);
        if (!el || !el.isConnected) return;
        if (
          el.classList.contains(TRANSLATED_CLASS) ||
          el.classList.contains(PENDING_CLASS) ||
          el.classList.contains(OBSERVED_CLASS)
        )
          return;
        if (el === hoverEl) return;
        if (hoverTimer) clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => showHoverBubbleFor(el), 500);
      },
      true,
    );

    let hoverHideTimer: ReturnType<typeof setTimeout> | null = null;
    document.addEventListener(
      'mousemove',
      (e) => {
        if (!hoverEl || hoverPinned || !hoverBubble) return;
        const target = e.target as Element | null;
        if (target && (target.closest('#ot-hover-bubble') || hoverEl.contains(target))) {
          if (hoverHideTimer) {
            clearTimeout(hoverHideTimer);
            hoverHideTimer = null;
          }
          return;
        }
        // 延迟隐藏：给鼠标移向气泡的时间，避免气泡一闪就消失
        if (!hoverHideTimer) {
          hoverHideTimer = setTimeout(() => {
            hoverHideTimer = null;
            hideHoverBubble();
          }, 260);
        }
      },
      true,
    );

    document.addEventListener(
      'click',
      (e) => {
        const target = e.target as Element | null;
        if (target?.closest('#ot-hover-bubble')) return;
        if (hoverPinned) {
          hoverPinned = false;
          hideHoverBubble();
        }
      },
      true,
    );

    document.addEventListener('scroll', () => {
      if (!hoverPinned) hideHoverBubble();
    }, true);

    // ===== 输入框翻译：聚焦网页输入框时显示「译」按钮 =====
    let inputBtn: HTMLElement | null = null;
    let inputTarget: HTMLTextAreaElement | HTMLInputElement | null = null;
    let inputResultHost: HTMLElement | null = null;

    function isTranslatableInput(el: Element | null): el is HTMLTextAreaElement | HTMLInputElement {
      if (!el || !el.isConnected) return false;
      if (el instanceof HTMLTextAreaElement) return true;
      if (el instanceof HTMLInputElement) {
        const type = (el.type || 'text').toLowerCase();
        return ['text', 'search', 'url', 'email'].includes(type);
      }
      return false;
    }

    function positionInputBtn() {
      if (!inputBtn || !inputTarget) return;
      const r = inputTarget.getBoundingClientRect();
      const left = Math.max(8, r.right - 40);
      // 输入框高度足够（>44px）时按钮在框内右下角，否则移到框外下方避免遮挡
      const inside = r.height > 44 ? r.bottom - 40 : r.bottom + 4;
      inputBtn.style.setProperty('left', `${left}px`, 'important');
      inputBtn.style.setProperty('top', `${Math.max(8, Math.min(inside, window.innerHeight - 36))}px`, 'important');
    }

    function hideInputTranslate() {
      inputBtn?.remove();
      inputBtn = null;
      inputResultHost?.remove();
      inputResultHost = null;
      inputTarget = null;
    }

    async function translateInputContent() {
      // 未配置 Key：不发起请求，直接给引导。
      if (await guardSetupGate(true)) return;
      if (!inputTarget) return;
      const text = inputTarget.value.trim();
      if (!text) return;
      inputResultHost?.remove();
      const host = document.createElement('div');
      host.id = 'ot-input-result';
      host.dataset.haofanUi = 'true';
      host.style.setProperty('all', 'initial', 'important');
      host.style.setProperty('position', 'fixed', 'important');
      host.style.setProperty('z-index', '2147483646', 'important');
      host.style.setProperty('width', '320px', 'important');
      host.style.setProperty('max-width', 'calc(100vw - 24px)', 'important');
      host.style.setProperty('border-radius', '12px', 'important');
      // 深浅色随系统（内联样式无法被 media query 覆盖，直接按当前外观计算）
      const resultDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
      host.style.setProperty('background', resultDark ? 'rgba(28,28,30,0.96)' : 'rgba(255,255,255,0.96)', 'important');
      host.style.setProperty('color', resultDark ? '#f5f5f7' : '#1d1d1f', 'important');
      host.style.setProperty('box-shadow', '0 12px 36px rgba(0,0,0,0.2)', 'important');
      host.style.setProperty('backdrop-filter', 'blur(20px) saturate(180%)', 'important');
      host.style.setProperty('-webkit-backdrop-filter', 'blur(20px) saturate(180%)', 'important');
      host.style.setProperty('border', `1px solid ${resultDark ? 'rgba(84,84,88,0.5)' : 'rgba(60,60,67,0.14)'}`, 'important');
      host.style.setProperty('font-family', '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif', 'important');
      host.style.setProperty('padding', '10px 12px', 'important');
      host.style.setProperty('font-size', '13px', 'important');
      host.style.setProperty('line-height', '1.55', 'important');
      host.textContent = '翻译中…';
      document.documentElement.appendChild(host);
      inputResultHost = host;
      const r = inputTarget.getBoundingClientRect();
      host.style.setProperty('left', `${Math.min(Math.max(8, r.left), window.innerWidth - 328)}px`, 'important');
      host.style.setProperty('top', `${Math.max(8, r.bottom + 6)}px`, 'important');
      try {
        const res = await translateOneText(text, {
          onDelta: (partial) => {
            if (inputResultHost !== host || !partial) return;
            host.textContent = partial;
          },
        });
        if (inputResultHost !== host) return;
        {
          host.textContent = res.translation;
          const copy = document.createElement('button');
          copy.type = 'button';
          copy.textContent = '复制译文';
          Object.assign(copy.style, {
            display: 'block',
            marginTop: '8px',
            padding: '4px 10px',
            border: '0',
            borderRadius: '8px',
            background: 'rgba(0,122,255,0.12)',
            color: '#007aff',
            fontSize: '12px',
            fontWeight: '600',
            cursor: 'pointer',
            fontFamily: 'inherit',
          });
          copy.addEventListener('click', async () => {
            try {
              await navigator.clipboard.writeText(res.translation);
              copy.textContent = '已复制';
            } catch {
              copy.textContent = '复制失败';
            }
          });
          host.appendChild(copy);
        }
      } catch (error) {
        if (inputResultHost === host) {
          host.textContent = error instanceof Error ? error.message : '翻译失败';
        }
      }
    }

    document.addEventListener(
      'focusin',
      (e) => {
        if (!inputTranslateEnabled) return;
        const target = e.target as Element | null;
        if (!isTranslatableInput(target)) return;
        hideInputTranslate();
        inputTarget = target;
        inputBtn = createInputTranslateButton(() => {
          void translateInputContent();
        });
        document.documentElement.appendChild(inputBtn);
        positionInputBtn();
      },
      true,
    );

    document.addEventListener(
      'focusout',
      (e) => {
        const related = (e as FocusEvent).relatedTarget as Element | null;
        if (related && related.closest('#ot-input-btn, #ot-input-result')) return;
        hideInputTranslate();
      },
      true,
    );

    window.addEventListener('scroll', positionInputBtn, true);
    window.addEventListener('resize', positionInputBtn);

    function mountToolbar() {
      if (!sitePolicyLoaded || siteDisabled) return;
      if (document.getElementById('ot-toolbar')) return;

      const bar = document.createElement('div');
      bar.id = 'ot-toolbar';
      bar.dataset.haofanUi = 'true';
      // 使用内联样式覆盖一切可能的站点 CSS 干扰；挂载到 documentElement，
      // 避免 body 的 transform 破坏 fixed 定位。
      Object.assign(bar.style, {
        position: 'fixed',
        right: '20px',
        bottom: '20px',
        zIndex: '2147483647',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '5px',
        borderRadius: '999px',
        background: 'rgba(255,255,255,0.92)',
        backdropFilter: 'blur(18px) saturate(180%)',
        WebkitBackdropFilter: 'blur(18px) saturate(180%)',
        boxShadow: '0 6px 24px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.1)',
        border: '1px solid rgba(60,60,67,0.12)',
        cursor: 'grab',
        userSelect: 'none',
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif',
        transition: 'box-shadow 0.2s ease',
      });

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'ot-translate-btn';
      btn.textContent = '\u8BD1'; // "译"
      btn.title = '好翻 \u00B7 \u7FFB\u8BD1\u672C\u9875'; // "好翻 · 翻译本页"
      btn.setAttribute('aria-label', '翻译当前网页');
      Object.assign(btn.style, {
        width: '40px',
        height: '40px',
        borderRadius: '50%',
        border: 'none',
        padding: '0',
        background: 'linear-gradient(180deg, #2b8cff 0%, #007aff 100%)',
        color: '#fff',
        fontWeight: '600',
        fontSize: '16px',
        lineHeight: '1',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        boxShadow: '0 3px 10px rgba(0,122,255,0.35)',
        transition: 'transform 0.15s ease, background 0.2s ease',
        fontFamily: 'inherit',
      });

      const gear = document.createElement('button');
      gear.type = 'button';
      gear.id = 'ot-settings-btn';
      gear.textContent = '\u2699\uFE0E'; // ⚙（文本变体，避免 emoji 渲染）
      gear.title = '快速设置';
      gear.setAttribute('aria-label', '打开快速设置');
      Object.assign(gear.style, {
        width: '36px',
        height: '36px',
        borderRadius: '50%',
        border: 'none',
        padding: '0',
        background: 'transparent',
        color: '#6e6e73',
        fontSize: '17px',
        lineHeight: '1',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        transition: 'background 0.15s ease, color 0.15s ease',
        fontFamily: 'inherit',
      });
      gear.addEventListener('mouseenter', () => {
        gear.style.background = 'rgba(60,64,67,0.08)';
        gear.style.color = '#1d1d1f';
      });
      gear.addEventListener('mouseleave', () => {
        gear.style.background = 'transparent';
        gear.style.color = '#6e6e73';
      });

      // 深色模式适配：工具条底色与齿轮颜色跟随系统外观
      const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
      if (prefersDark) {
        bar.style.setProperty('background', 'rgba(28,28,30,0.92)', 'important');
        bar.style.setProperty('border-color', 'rgba(84,84,88,0.5)', 'important');
        gear.style.color = '#aeaeb2';
      }

      bar.append(btn, gear);
      try {
        document.documentElement.appendChild(bar);
      } catch {
        (document.body || document.documentElement).appendChild(bar);
      }

      // 整条工具条可拖动；位移超过阈值视为拖拽，不触发按钮点击。
      const draggable = makeDraggable(bar, bar, (x, y) => {
        void toolbarPosItem.setValue({ x, y }).catch(() => {});
      });
      const wasDrag = () => draggable.suppressNextClick();

      // 恢复上次拖拽位置
      void toolbarPosItem
        .getValue()
        .then((pos) => {
          if (!pos || !document.getElementById('ot-toolbar')) return;
          bar.style.right = 'auto';
          bar.style.bottom = 'auto';
          bar.style.left = `${Math.min(Math.max(0, pos.x), Math.max(0, window.innerWidth - bar.offsetWidth))}px`;
          bar.style.top = `${Math.min(Math.max(0, pos.y), Math.max(0, window.innerHeight - bar.offsetHeight))}px`;
        })
        .catch(() => {});

      // 点击委托在整条工具条上：点击容器任意位置（齿轮除外）都触发翻译，
      // 拖拽位移超过阈值时 suppressNextClick 忽略本次点击。
      bar.addEventListener('click', (event) => {
        if (wasDrag()) return;
        if ((event.target as Element | null)?.closest?.('#ot-settings-btn')) return;
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
          translatePage(true, true);
        }
      });
      gear.addEventListener('click', (event) => {
        if (wasDrag()) return;
        event.stopPropagation();
        const rect = gear.getBoundingClientRect();
        void openSettingsPanel(rect.left, rect.bottom + 8);
      });
    }

    function setToolbarLoading(loading: boolean) {
      const bar = document.getElementById('ot-toolbar');
      const btn = document.getElementById('ot-translate-btn');
      if (bar) {
        if (loading) {
          bar.setAttribute('aria-busy', 'true');
          bar.setAttribute('aria-label', '取消当前翻译');
        } else {
          bar.setAttribute('aria-busy', 'false');
          bar.setAttribute('aria-label', '翻译当前网页');
        }
      }
      if (!btn) return;
      if (loading) {
        // 加载态：旋转圆圈指示器 + "取消翻译"（点击可取消），状态一目了然。
        btn.setAttribute('aria-busy', 'true');
        btn.setAttribute('aria-label', '取消当前翻译');
        btn.style.setProperty('width', 'auto', 'important');
        btn.style.setProperty('padding', '0 12px', 'important');
        btn.style.setProperty('border-radius', '22px', 'important');
        btn.style.setProperty('font-size', '13px', 'important');
        btn.style.setProperty('background', '#8fb8ef', 'important');
        btn.style.cursor = 'progress';
        btn.textContent = '';
        const spinner = document.createElement('span');
        spinner.className = 'ot-toolbar-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        // 基础样式内联（不依赖 content.css 注入时机）；旋转动画由 content.css 提供。
        Object.assign(spinner.style, {
          display: 'inline-block',
          width: '14px',
          height: '14px',
          marginRight: '6px',
          flex: '0 0 14px',
          border: '2px solid rgba(255,255,255,0.45)',
          borderTopColor: '#fff',
          borderRadius: '50%',
        });
        const label = document.createElement('span');
        label.textContent = '取消翻译';
        btn.append(spinner, label);
        btn.title = '取消当前翻译';
      } else {
        btn.setAttribute('aria-busy', 'false');
        btn.setAttribute('aria-label', '翻译当前网页');
        // 注意：不能 removeProperty——inline 样式里的原始 width 也会被一并删除，
        // 导致按钮缩回内容宽度（约 25px），工具条整体变窄（历史隐藏 bug）。
        btn.style.setProperty('width', '40px', 'important');
        btn.style.setProperty('padding', '0', 'important');
        btn.style.setProperty('border-radius', '50%', 'important');
        btn.style.setProperty('font-size', '16px', 'important');
        btn.style.setProperty('background', 'linear-gradient(180deg, #2b8cff 0%, #007aff 100%)', 'important');
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
