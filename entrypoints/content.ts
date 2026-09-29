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
  isInteractiveControl,
} from '../utils/dom.ts';
import { planTextChunks, takeFirstTextChunk } from '../utils/chunking.ts';
import {
  configItem,
  disabledSitesItem,
  autoSitesItem,
  alwaysSitesItem,
  neverSitesItem,
  toolbarPosItem,
  settingsPanelPosItem,
  setupNoticeShownItem,
} from '../utils/storage.ts';
import { applyManualDefaultMigration } from '../utils/storage.ts';
import {
  createTranslationNode,
  createNoticeHost,
  createSelectionUiStyle,
  createSettingsPanel,
  createHoverBubble,
  createInputTranslateButton,
  makeDraggable,
  setThemeOverride,
  themeColors,
  applyThemeVars,
} from '../utils/content-ui.ts';
import { mountImageResultOverlay } from '../utils/image-overlay.ts';
import { isRetryableTranslationError, NoticeCycleGate } from '../utils/notice-policy.ts';
import { SessionTranslationCache } from '../utils/session-translation-cache.ts';
import { addHistoryEntry } from '../utils/history-store.ts';
import { randomId } from '../utils/id.ts';
import {
  isSiteDisabled,
  withSiteDisabled,
  isAlwaysSite,
  withAlwaysSite,
  isNeverSite,
  withNeverSite,
} from '../utils/site-policy.ts';
import { UI_SURFACE_SELECTOR } from '../utils/dom.ts';
import { normalizeConfig, getProviderApiKey, type AppConfig } from '../utils/config.ts';
import { buildConfigForm } from '../utils/ui.ts';
// 设置页样式直接打包进内容脚本（?raw），完整设置面板无需 fetch 扩展资源。
import fullSettingsCss from '../styles/options.css?raw';
import { LANGUAGES } from '../utils/languages.ts';
import { PROVIDERS } from '../utils/providers.ts';
import { createSpeakButton, stopSpeaking } from '../utils/speech.ts';
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
  // 顶层文档脚本：UI（工具栏/浮层/划词）与整页翻译。
  // iframe 内嵌内容暂不翻译（主脚本 UI 与翻译深度耦合，独立 iframe 脚本留待后续）。
  runAt: 'document_idle',
  main() {
    // v0.2.0 一次性迁移：翻译模式默认改为「手动」（SW 休眠时由内容脚本兜底执行）
    void applyManualDefaultMigration();
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
    // 整页翻译任务代际：每次进入 translatePage 递增（mySeq），用户点「取消」时把
    // pageCancelSeq 推进到当前代。启动序列中的 await 恢复后据此判断是否已被取消，
    // 避免「取消点击手工复位 busy 与尚未完成的启动序列竞态」导致状态失步后
    // 再次触发并发整页翻译。
    let pageRunSeq = 0;
    let pageCancelSeq = 0;
    let translatedCount = 0; // 已插入译文计数（避免每次 querySelectorAll 全文档统计，省性能）
    let pageTotalFound = 0; // 本次整页扫描发现的段落总数（进度显示用）
    let estimatedTokensSaved = 0;
    let dynamicActive = false;
    let dynamicObserver: MutationObserver | null = null;
    let dynamicClickTimer: ReturnType<typeof setTimeout> | null = null;
    let dynamicQueueTimer: ReturnType<typeof setTimeout> | null = null;
    const dynamicRoots = new Set<Element>();
    let dynamicClickHandler: ((event: Event) => void) | null = null;
    // click-scan 防抖窗口内收集的点击目标（stopDynamic 需要跨作用域清理）
    let clickTargets: Set<Element> | null = null;
    // 动态重译冷却队列：元素 → 到期时间戳（stopDynamic 需要跨作用域清理）
    const cooldownDeadlines = new Map<Element, number>();
    let cooldownTimer: ReturnType<typeof setTimeout> | null = null;
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
    // 0.2.2 译文排版自定义：跟随配置加载与变化，插译文节点时传给 createTranslationNode。
    let currentFontSize = 0;
    let currentLineHeight = 0;
    let currentOpacity = 0;
    let currentColor = '';
    // 0.2.2 对照模式：below=译文在原文下方（默认）；translation-only=只显示译文（原文悬停显示）；
    // hover-original=显示译文但悬停译文时临时显示原文（与沉浸式「悬停看原文」对应）。
    let currentDualMode: 'below' | 'translation-only' | 'hover-original' = 'below';
    let currentTranslateMode: 'auto' | 'manual' = 'manual';
    // 主引擎基准（降级提示用）：配置加载与变化时同步；实际成功引擎与之不同即发生降级。
    let currentProvider = '';
    // 站点级「总是自动翻译此站」显式开启时，覆盖全局手动模式——该站表现为完整自动翻译
    let thisSiteAutoOverride = false;
    const effectiveAutoMode = () => currentTranslateMode === 'auto' || thisSiteAutoOverride;
  // 当前目标语言与人声（TTS 朗读使用）：配置加载与变化时同步。
  let currentTargetLang = '中文';
  let currentTtsVoice = '';
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
    // 0.2.2 白名单 / 敏感列表变化：重新评估本站站点规则（可能触发 自动翻译 / 暂停）
    try {
      alwaysSitesItem.watch(() => {
        sitePolicyRevision++;
        void refreshSiteRules();
      });
    } catch {
      /* 存储监听不可用 */
    }
    try {
      neverSitesItem.watch(() => {
        sitePolicyRevision++;
        void refreshSiteRules();
      });
    } catch {
      /* 存储监听不可用 */
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
        // 站点规则统一评估：敏感(never) / 暂停(disabled) / 白名单(always，强制自动) / 自动列表(auto)。
        // 0.2.2 起改用 refreshSiteRules() 一次性覆盖全部规则，避免各列表各自校验互相冲突。
        try {
          if (!sitePolicyLoaded) {
            await new Promise<void>((resolve) => {
              const timer = setInterval(() => {
                if (sitePolicyLoaded) {
                  clearInterval(timer);
                  resolve();
                }
              }, 60);
            });
          }
          // 传入链起始 revision：消息在读取期间到达也算竞态，放弃本次列表评估
          await refreshSiteRules(initialSitePolicyRevision);
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
        if (v && typeof v.provider === 'string') currentProvider = v.provider;
        if (v && (v.translateMode === 'auto' || v.translateMode === 'manual')) currentTranslateMode = v.translateMode;
        hoverTranslateEnabled = v ? v.hoverTranslate !== false : true;
        inputTranslateEnabled = v ? v.inputTranslate !== false : true;
        streamingEnabled = v ? v.streaming !== false : true;
        // 0.2.2 排版自定义与对照模式：配置变化时同步本地状态，
        // 并对已渲染译文就地更新样式 / 对照模式（无需重译）。
        if (v && typeof v.translationFontSize === 'number') currentFontSize = v.translationFontSize;
        if (v && typeof v.translationLineHeight === 'number') currentLineHeight = v.translationLineHeight;
        if (v && typeof v.translationOpacity === 'number') currentOpacity = v.translationOpacity;
        if (v && typeof v.translationColor === 'string') currentColor = v.translationColor;
        if (v && (v.dualMode === 'below' || v.dualMode === 'translation-only' || v.dualMode === 'hover-original')) {
          currentDualMode = v.dualMode;
        }
        document.querySelectorAll('.ot-translation').forEach((el) => {
          (el as HTMLElement).dataset.style = currentTranslationStyle;
        });
        applyDualModeToExisting();
        applyTypographyToExisting();
      });
      void configItem
        .getValue()
        .then((v) => {
          if (v) {
            setThemeOverride(v.themeMode === 'light' || v.themeMode === 'dark' ? v.themeMode : 'auto');
            if (typeof v.targetLang === 'string') currentTargetLang = v.targetLang;
            currentTtsVoice = typeof v.ttsVoiceName === 'string' ? v.ttsVoiceName : '';
          }
          if (v && typeof v.translationStyle === 'string') currentTranslationStyle = v.translationStyle;
          if (v && typeof v.provider === 'string') currentProvider = v.provider;
          if (v && (v.translateMode === 'auto' || v.translateMode === 'manual')) currentTranslateMode = v.translateMode;
          hoverTranslateEnabled = v ? v.hoverTranslate !== false : true;
          inputTranslateEnabled = v ? v.inputTranslate !== false : true;
          streamingEnabled = v ? v.streaming !== false : true;
          if (v && typeof v.translationFontSize === 'number') currentFontSize = v.translationFontSize;
          if (v && typeof v.translationLineHeight === 'number') currentLineHeight = v.translationLineHeight;
          if (v && typeof v.translationOpacity === 'number') currentOpacity = v.translationOpacity;
          if (v && typeof v.translationColor === 'string') currentColor = v.translationColor;
          if (v && (v.dualMode === 'below' || v.dualMode === 'translation-only' || v.dualMode === 'hover-original')) {
            currentDualMode = v.dualMode;
          }
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
        // 主题手动覆盖（auto/light/dark）：影响后续新建的所有浮层。
        setThemeOverride(v.themeMode === 'light' || v.themeMode === 'dark' ? v.themeMode : 'auto');
        if (typeof v.targetLang === 'string') currentTargetLang = v.targetLang;
        if (typeof v.provider === 'string') currentProvider = v.provider;
        currentTtsVoice = typeof v.ttsVoiceName === 'string' ? v.ttsVoiceName : '';
        hoverTranslateEnabled = v.hoverTranslate !== false;
        inputTranslateEnabled = v.inputTranslate !== false;
        streamingEnabled = v.streaming !== false;
        // 刚在页内设置面板里填好 Key：给出明确的下一步指引，不用再点一次按钮。
        if (awaitingSetup && !providerNeedsSetup(normalizeConfig(v))) {
          awaitingSetup = false;
          closeNotice();
          if (!siteDisabled && !document.querySelector('.ot-translation')) {
            if (currentTranslateMode === 'manual') {
              showStatus('配置完成 ✓ 点击段落或划选文字即可翻译', true, 4000);
            } else {
              void translatePage(true);
            }
          }
        }
        if (v.translateMode === 'auto' || v.translateMode === 'manual') {
          const prevMode = currentTranslateMode;
          currentTranslateMode = v.translateMode;
          // 工具栏空闲态文案跟随模式变化；切入手动模式时给一次性操作提示。
          refreshToolbarIdleLabels();
          if (prevMode !== 'manual' && currentTranslateMode === 'manual' && dynamicActive && !thisSiteAutoOverride) stopDynamic();
          if (prevMode !== 'manual' && currentTranslateMode === 'manual' && !thisSiteAutoOverride && !busy && !siteDisabled) {
            showStatus('已切换到手动模式：点击段落或划选文字即可翻译', true, 3500);
          }
        }
        settingsPanel?.update({
          targetLang: v.targetLang,
          provider: v.provider,
          translateMode: v.translateMode === 'manual' ? 'manual' : 'auto',
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
        // 站点级显式开启 → 覆盖全局手动模式；工具栏等空闲态文案随之刷新
        thisSiteAutoOverride = sites !== null && isSiteDisabled(sites, location.href);
        refreshToolbarIdleLabels();
        settingsPanel?.update({ autoTranslate: autoOn });
        fullSettingsFormApi?.updateSiteState(autoOn, undefined);
      });
      safeWatch(alwaysSitesItem, (sites) => {
        const alwaysOn = isAlwaysSite(sites, location.href);
        settingsPanel?.update({ siteAlways: alwaysOn });
        fullSettingsFormApi?.updateSiteState(undefined, undefined, alwaysOn, undefined);
      });
      safeWatch(neverSitesItem, (sites) => {
        const neverOn = isNeverSite(sites, location.href);
        settingsPanel?.update({ siteNever: neverOn });
        fullSettingsFormApi?.updateSiteState(undefined, undefined, undefined, neverOn);
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
    type StreamResult = {
      translation: string;
      issue: string[] | null;
      savedTokens: number;
      /** 命中「原文已是目标语言」本地跳过：界面据此提示而非静默显示原文 */
      localSkipped?: boolean;
      /** 实际成功引擎：主引擎失败降级后为备用引擎 id（默认=主引擎），前端据此提示降级 */
      usedProvider?: string;
    };
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
    let streamRetryTimer: ReturnType<typeof setTimeout> | null = null;
    const STREAM_RETRY_MS = 30_000;
    const streamWaiters = new Map<string, StreamWaiter>();

    // 端口暂不可用时进入冷却：30 秒后自动恢复尝试。
    // 此前是一次失败即本页永久禁用流式——一次瞬时抖动（如 SW 正在重启）
    // 就再也无法享受首字加速，与「流式不可用才回退」的设计意图不符。
    function markStreamUnavailable() {
      streamUnavailable = true;
      if (streamRetryTimer) return;
      streamRetryTimer = setTimeout(() => {
        streamRetryTimer = null;
        streamUnavailable = false;
      }, STREAM_RETRY_MS);
    }

    // 空闲超时而非总超时：只要还在往外吐字就不算卡住，长文也能正常译完。
    function armStreamTimer(id: string, waiter: StreamWaiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.timer = setTimeout(() => {
        if (streamWaiters.delete(id)) {
          waiter.reject(new Error('流式翻译响应超时'));
          // 本地已放弃并回退普通请求：通知后台取消流式生成，
          // 否则同一文本会并发生成两份（双倍 Token 与限流压力）。
          notifyCancelStream(id);
        }
      }, STREAM_IDLE_TIMEOUT_MS);
    }

    // 请求已被本地放弃（超时/回退）时通知后台中止生成。端口已断开则无需通知。
    function notifyCancelStream(id: string) {
      const port = streamPort;
      if (!port) return;
      try {
        port.postMessage({ type: 'cancel-one', id });
      } catch {
        /* 端口正在关闭：后台断连时会自行中止 */
      }
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
            usedProvider?: unknown;
            error?: unknown;
            stats?: { estimatedTokensSaved?: unknown; localSkipped?: unknown };
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
        localSkipped: msg.stats?.localSkipped === true,
        usedProvider: typeof msg.usedProvider === 'string' ? msg.usedProvider : undefined,
      });
    }

    function getStreamPort(): StreamPort | null {
      if (streamUnavailable) return null;
      if (streamPort) return streamPort;
      try {
        const port = (runtime as any).connect?.({ name: 'haofan-stream' }) as StreamPort | undefined;
        if (!port) {
          markStreamUnavailable();
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
        // connect 抛错多为瞬时状态（扩展更新 / SW 重启中），进入冷却后自动恢复。
        markStreamUnavailable();
        return null;
      }
    }

    // 返回 null 表示流式当前不可用（开关关闭或端口连不上），调用方应走普通请求。
    function streamTranslateOne(
      text: string,
      onDelta: (partial: string) => void,
      options?: { jobId?: string; context?: { title?: string; prev?: string }; signal?: AbortSignal },
    ): Promise<StreamResult> | null {
      if (!streamingEnabled) return null;
      const port = getStreamPort();
      if (!port) return null;
      const id = randomId();
      return new Promise<StreamResult>((resolve, reject) => {
        const waiter: StreamWaiter = { port, onDelta, resolve, reject, timer: null };
        streamWaiters.set(id, waiter);
        armStreamTimer(id, waiter);
        // 所有等待方离开时整条请求被中止：主动通知后台取消生成（避免白烧 Token），
        // 并同步拒绝本地 waiter，防止悬挂的 Promise 在后台结果到达时才被唤醒。
        const onAbort = () => {
          if (streamWaiters.delete(id)) {
            if (waiter.timer) clearTimeout(waiter.timer);
            notifyCancelStream(id);
            reject(new Error('翻译任务已取消'));
          }
        };
        if (options?.signal) {
          if (options.signal.aborted) {
            onAbort();
            return;
          }
          options.signal.addEventListener('abort', onAbort, { once: true });
        }
        try {
          port.postMessage({
            type: 'translate-one',
            id,
            text,
            jobId: options?.jobId,
            context: options?.context,
          });
        } catch (error) {
          options?.signal?.removeEventListener('abort', onAbort);
          if (waiter.timer) clearTimeout(waiter.timer);
          streamWaiters.delete(id);
          if (streamPort === port) streamPort = null;
          reject(error instanceof Error ? error : new Error('流式请求发送失败'));
        }
      });
    }

    // 单条翻译统一入口：能流式就流式（首字更快），流式不可用 / 超时 / 出错立即回退普通请求，
    // 回退后的最终译文会覆盖已经显示的增量，用户看不到中间失败。
    // in-flight 去重：同一文本在途时复用同一请求，避免悬停移开再移回 / 快速重复触发双发
    // （双发 = 双倍 Token）。键含配置版本与目标语言：配置变化后旧请求结果不再被新场景复用。
    // 所有等待方离开且请求未完成时中止整个请求（含流式取消与普通请求回退拦截），
    // 避免「移开不再回来」的悬停气泡把一次无人查看的翻译跑完白烧 Token。
    const pendingSingleTranslations = new Map<
      string,
      {
        promise: Promise<StreamResult>;
        deltas: Set<(partial: string) => void>;
        controller: AbortController;
      }
    >();
    async function translateOneText(
      text: string,
      options?: {
        jobId?: string;
        context?: { title?: string; prev?: string };
        onDelta?: (partial: string) => void;
      },
    ): Promise<StreamResult> {
      const requestKey = `${translationConfigRevision}|${currentTargetLang}|${text}`;
      const inFlight = pendingSingleTranslations.get(requestKey);
      if (inFlight) {
        // 复用同一在途请求：增量广播给所有等待方，完成后共享结果。
        const hadDelta = !!options?.onDelta;
        if (options?.onDelta) inFlight.deltas.add(options.onDelta);
        try {
          return await inFlight.promise;
        } finally {
          if (options?.onDelta) inFlight.deltas.delete(options.onDelta);
          // 等待方全部离开（复用者退出且发起者已无增量订阅）→ 无人查看，中止整条请求。
          if (hadDelta && inFlight.deltas.size === 0 && !inFlight.controller.signal.aborted) {
            inFlight.controller.abort();
          }
        }
      }
      const deltas = new Set<(partial: string) => void>();
      if (options?.onDelta) deltas.add(options.onDelta);
      const controller = new AbortController();
      const promise = doTranslateOneText(text, deltas, controller.signal, options);
      pendingSingleTranslations.set(requestKey, { promise, deltas, controller });
      try {
        const result = await promise;
        // 仅发起方累计「约省 Token」：等待方复用同一请求，不重复累加（数字虚高会误导用户）。
        estimatedTokensSaved += result.savedTokens;
        return result;
      } finally {
        // 仅当仍指向本请求时清除：配置变化后新键已生成，旧项自然淘汰。
        if (pendingSingleTranslations.get(requestKey)?.promise === promise) {
          pendingSingleTranslations.delete(requestKey);
        }
        deltas.clear();
      }
    }
    async function doTranslateOneText(
      text: string,
      deltas: Set<(partial: string) => void>,
      signal: AbortSignal,
      options?: {
        jobId?: string;
        context?: { title?: string; prev?: string };
        onDelta?: (partial: string) => void;
      },
    ): Promise<StreamResult> {
      const broadcastDelta = (partial: string) => {
        deltas.forEach((cb) => {
          try {
            cb(partial);
          } catch {
            /* 单个调用方渲染失败不影响其他等待方 */
          }
        });
      };
      if (options?.onDelta) {
        const streamed = streamTranslateOne(text, broadcastDelta, {
          ...options,
          signal,
        });
        if (streamed) {
          try {
            const result = await streamed;
            if (result.translation) {
              maybeNotifyFallback(result.usedProvider);
              return result;
            }
          } catch (error) {
            // 所有等待方已离开（移开不再回来）：整条请求被中止，直接抛错不回退普通请求。
            // 否则流式取消后落入 TRANSLATE_ONE 普通请求，等于没省 Token。
            if (signal.aborted) throw error;
            /* 落到下面的普通请求 */
          }
        }
      }
      // 普通请求无原生取消：abort 时放弃等待（请求可能在后台继续，但已无任何 UI 等待方，
      // 且后台自身有 15s 空闲超时 + 任务取消联动，不会无限占用）。
      if (signal.aborted) throw new Error('翻译任务已取消');
      const res: any = await new Promise<any>((resolve, reject) => {
        const onAbort = () => reject(new Error('翻译任务已取消'));
        if (signal.aborted) {
          reject(new Error('翻译任务已取消'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        sendRuntimeMessage({
          type: 'TRANSLATE_ONE',
          payload: { text, jobId: options?.jobId, context: options?.context },
        }).then(
          (value) => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
          },
          (error) => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
          },
        );
      });
      if (!res?.ok) throw new Error(res?.error || '翻译失败');
      const translation = typeof res.translation === 'string' ? res.translation : '';
      if (!translation) throw new Error('翻译服务返回了空结果');
      maybeNotifyFallback(typeof res.usedProvider === 'string' ? res.usedProvider : undefined);
      return {
        translation,
        issue: Array.isArray(res.issue) ? (res.issue as string[]) : null,
        savedTokens: Math.max(0, Number(res.stats?.estimatedTokensSaved) || 0),
        localSkipped: res.localSkipped === true,
        usedProvider: typeof res.usedProvider === 'string' ? res.usedProvider : undefined,
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
    let lastGuideRenderAt = 0;
    function showSetupGuide(force = false) {
      // 根治「点一下弹一次」：引导已在屏时绝不重绘（即便 force）；
      // 非强制路径再加 1.2s 时间节流，防止关闭后瞬时连触发。
      if (noticeHost?.isConnected) return;
      if (!force && Date.now() - lastGuideRenderAt < 1200) return;
      const open = () => {
        closeNotice();
        openFullSettingsPanel();
      };
      const render = () => {
        closeNotice();
        lastGuideRenderAt = Date.now();
        noticeHost = createNoticeHost(
          '还差一步就能开始翻译',
          '好翻直接调用你自己的大模型账号，Key 只保存在本机浏览器。填入 API Key 后，点击段落或划选文字即可翻译。',
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
      // 单条路径被拦下同样置位 awaitingSetup：用户填好 Key 后的自动续翻
      // 回调依赖它（此前只对整页生效，悬停/划词触发引导后填 Key 不会接着翻）。
      // 手动模式下整页续翻不会执行（translatePage 会提示手动模式），但置位无害。
      awaitingSetup = true;
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
        // 0.2.2 排版自定义：0 = 跟随原文默认值
        fontSize: currentFontSize > 0 ? currentFontSize : undefined,
        lineHeight: currentLineHeight > 0 ? currentLineHeight : undefined,
        opacity: currentOpacity > 0 ? currentOpacity : undefined,
        color: currentColor || undefined,
      });
      translationNodes.set(el, node);
      // 第 17 轮：隐藏态下新插入的译文必须跟随隐藏——否则「已隐藏译文」时
      // 滚动懒加载 / SPA 动态内容 / 重译产生的新译文节点自带 display:block
      // !important（外部 CSS 的 !important 压不住内联），会突然显示出来，
      // 而按钮与根类仍处于「已隐藏」，出现状态失步。
      if (translationsHidden) {
        node.style.setProperty('display', 'none', 'important');
      }
      // 节点上直接挂锚点引用：对照模式批量应用时需要「节点 → 原文锚点」的反查
      //（WeakMap 不可迭代），且避免按 class 猜测锚点出现误判。
      (node as HTMLSpanElement & { otAnchor?: Element }).otAnchor = el;
      applyDualModeToNode(el, node);
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
      // 普通流中紧邻原文插入；Flex/Grid 直接子项、float、CSS 多列、绝对定位锚点
      // 等会视觉错位的场景首选嵌入原文块内部。每种策略渲染后做几何校验
      // （应位于锚点正下方、未跨列、未被裁剪），不达标自动降级到下一策略。
      applyWithFallback(el, node, computePlacementStrategies(el));
    }

    // ===== 0.2.2 对照模式：below / translation-only / hover-original =====
    // below：译文在原文下方（默认，已有行为）。
    // translation-only：隐藏原文只留译文，悬停译文时临时显示原文（找回原文）。
    // hover-original：译文在下方，悬停译文时临时把原文高亮显示（对照阅读）。
    // 实现一律走「类切换 + 内联覆盖」：译文节点自带 display:block !important，
    // 且测试页不加载 content.css，仅靠外部样式表不可靠（第 5 轮踩过同样的坑），
    // 因此原文显隐 / 悬停高亮直接写内联样式，CSS 类作为状态标记与生产兜底。
    // 切换不删节点、不重译（0 Token）。
    const DUAL_HIDDEN_OPACITY = '0';
    const DUAL_HIDDEN_USER_SELECT = 'none';
    function applyDualModeToNode(el: Element, node: HTMLSpanElement) {
      const mode = currentDualMode;
      const source = el as HTMLElement;
      if (mode === 'below') {
        node.classList.remove('ot-dual-translation-only', 'ot-dual-hover-original');
        node.classList.add('ot-dual-below');
        source.classList.remove('ot-dual-source-hidden', 'ot-dual-source-hover');
        source.style.removeProperty('opacity');
        source.style.removeProperty('user-select');
        source.style.removeProperty('background');
        return;
      }
      if (mode === 'translation-only') {
        node.classList.remove('ot-dual-below', 'ot-dual-hover-original');
        node.classList.add('ot-dual-translation-only');
        // 原文隐藏，但保留占位锚点高度避免整页跳动；悬停译文时恢复原文。
        source.classList.add('ot-dual-source-hidden');
        source.classList.remove('ot-dual-source-hover');
        source.style.setProperty('opacity', DUAL_HIDDEN_OPACITY, 'important');
        source.style.setProperty('user-select', DUAL_HIDDEN_USER_SELECT, 'important');
        source.style.removeProperty('background');
        return;
      }
      // hover-original
      node.classList.remove('ot-dual-below', 'ot-dual-translation-only');
      node.classList.add('ot-dual-hover-original');
      source.classList.remove('ot-dual-source-hidden');
      source.classList.add('ot-dual-source-hover');
      source.style.removeProperty('opacity');
      source.style.removeProperty('user-select');
      source.style.removeProperty('background');
    }

    // 悬停译文时：translation-only 恢复原文（opacity 1）；hover-original 高亮背景。
    function applyDualHover(anchor: Element, active: boolean) {
      const host = anchor as HTMLElement;
      if (currentDualMode === 'translation-only') {
        host.style.setProperty('opacity', active ? '1' : DUAL_HIDDEN_OPACITY, 'important');
      } else if (currentDualMode === 'hover-original') {
        host.style.setProperty(
          'background',
          active ? 'rgba(255, 193, 7, 0.16)' : '',
          'important',
        );
        if (active) host.style.setProperty('border-radius', '3px', 'important');
        else host.style.removeProperty('border-radius');
      }
    }

    function applyDualModeToExisting() {
      document.querySelectorAll('.ot-translation').forEach((node) => {
        const span = node as HTMLSpanElement & { otAnchor?: Element };
        const anchor = span.otAnchor;
        if (anchor && anchor.isConnected) applyDualModeToNode(anchor, span);
        else {
          span.classList.remove('ot-dual-below', 'ot-dual-translation-only', 'ot-dual-hover-original');
          span.classList.add(currentDualMode === 'below' ? 'ot-dual-below' : 'ot-dual-translation-only');
        }
      });
    }

    // 0.2.2 排版自定义批量应用：配置变化时更新已渲染译文，无需重译。
    function applyTypographyToExisting() {
      document.querySelectorAll('.ot-translation').forEach((node) => {
        const host = node as HTMLElement;
        if (currentFontSize > 0) host.style.setProperty('--ot-font-size', `${currentFontSize}px`);
        else host.style.removeProperty('--ot-font-size');
        if (currentLineHeight > 0) host.style.setProperty('--ot-line-height', String(currentLineHeight));
        else host.style.removeProperty('--ot-line-height');
        if (currentOpacity > 0) host.style.setProperty('--ot-opacity', String(currentOpacity));
        else host.style.removeProperty('--ot-opacity');
        if (currentColor) host.style.setProperty('--ot-color', currentColor);
        else host.style.removeProperty('--ot-color');
      });
    }

    type PlacementStrategy = 'inside' | 'afterend';

    // 「嵌入原文块内部」时，若锚点自身是行向 flex/grid 容器，直接 append 会让
    // 译文排到右侧而不是下方。沿最后一个元素子级向下潜行，直到找到纵向堆叠
    // 的容器再落点（典型：卡片 flex 行 > 内容列 > 段落）。
    function findVerticalHost(start: Element): HTMLElement {
      let host = start as HTMLElement;
      for (let depth = 0; depth < 6; depth++) {
        const kids = host.children;
        if (kids.length === 0) break;
        const cs = getComputedStyle(host);
        let horizontal = false;
        if (cs.display.includes('flex')) {
          horizontal = !(cs.flexDirection || 'row').includes('column');
        } else if (cs.display.includes('grid')) {
          const cols = (cs.gridTemplateColumns || '').split(' ').filter(Boolean).length;
          horizontal = cols > 1;
        }
        if (!horizontal) break;
        const last = kids[kids.length - 1] as HTMLElement | undefined;
        if (!last || last.tagName === 'BR') break;
        // 下潜目标是「原子」视觉单元时必须停：按钮/行内元素/「文本+按钮」混合条
        // （Apple 官网 hero 价格条）被塞入译文后会撑爆——胶囊变圆、横条爆高。
        if (isInteractiveControl(last)) break;
        if (getComputedStyle(last).display.startsWith('inline')) break;
        if (last.querySelector('a, button, [role="button"]')) break;
        host = last;
      }
      return host;
    }

    function computePlacementStrategies(el: Element): PlacementStrategy[] {
      const cs = getComputedStyle(el);
      const parentCs = el.parentElement ? getComputedStyle(el.parentElement) : null;
      const parentCreatesLayout =
        !!parentCs &&
        ['flex', 'inline-flex', 'grid', 'inline-grid', 'table', 'table-row'].includes(
          parentCs.display,
        );
      const ownFloat = cs.float !== 'none';
      const ownAbs = cs.position === 'absolute' || cs.position === 'fixed';
      // 行向 flex/grid 的「inside + 纵向下潜」会把译文塞进子项内部，把按钮
      // 撑变形（Apple 官网 .tile-ctas 的胶囊按钮被撑成正圆），或作为新 item
      // 挤压整行布局：这类锚点一律插到容器外面。
      const ownHorizontalFlex =
        (cs.display.includes('flex') && !(cs.flexDirection || 'row').includes('column')) ||
        (cs.display.includes('grid') &&
          (cs.gridTemplateColumns || '').split(' ').filter(Boolean).length > 1);
      // 多列布局祖先加深到 6 层：嵌套卡片内的多列文本此前漏判导致译文流入下一列
      let columnAncestor = false;
      let depth = 0;
      for (
        let p = el.parentElement;
        p && p !== document.documentElement && depth < 6;
        p = p.parentElement, depth++
      ) {
        const c2 = getComputedStyle(p);
        if (c2.columnCount !== 'auto' || c2.columnWidth !== 'auto') {
          columnAncestor = true;
          break;
        }
      }
      if (ownHorizontalFlex) return ['afterend'];
      if (parentCreatesLayout || ownFloat || ownAbs || columnAncestor) {
        return ['inside', 'afterend'];
      }
      return ['afterend', 'inside'];
    }

    // 几何校验：译文应大致位于锚点正下方且未跨列、未被 overflow 裁剪成不可见。
    function isPlacementOk(anchor: Element, node: HTMLElement): boolean {
      if (!node.isConnected) return false;
      const a = anchor.getBoundingClientRect();
      const n = node.getBoundingClientRect();
      if (n.width === 0 && n.height === 0) return false; // 被裁剪或渲染失败
      if (n.top < a.top - 12) return false; // 跑到了锚点上方
      const drifted =
        n.right < a.left - 8 || n.left > a.right + Math.max(a.width * 0.75, 60);
      if (drifted) return false; // 落进相邻列视为错位
      // 「嵌入内部」策略下被固定高度 + hidden 祖先裁剪：节点底部越出锚点底部
      // 且存在实际滚动的 overflow 裁剪祖先把超界部分藏掉 → 视为不可见，降级到外部。
      if (n.bottom > a.bottom + 4 && getComputedStyle(anchor).position !== 'absolute') {
        let p = anchor.parentElement;
        for (let d = 0; p && p !== document.documentElement && d < 5; p = p.parentElement, d++) {
          const o = getComputedStyle(p).overflowY;
          const clips = o === 'hidden' || o === 'clip' || o === 'scroll' || o === 'auto';
          const pr = p.getBoundingClientRect();
          if (clips && pr.height + 2 < p.scrollHeight && n.bottom > pr.bottom + 2) {
            return false;
          }
        }
      }
      return true;
    }

    function applyWithFallback(
      el: Element,
      node: HTMLElement,
      strategies: PlacementStrategy[],
      index = 0,
    ): void {
      const strategy = strategies[index];
      if (!strategy) return;
      if (strategy === 'inside') {
        // 行向 flex/grid 容器内沿最后子级纵向下潜，避免译文排到右侧
        findVerticalHost(el).appendChild(node);
      } else {
        el.insertAdjacentElement('afterend', node);
      }
      // 渲染后测量真实几何位置；错位则移除并尝试下一策略（最多两轮降级）。
      requestAnimationFrame(() => {
        if (!node.isConnected) return;
        if (index + 1 < strategies.length && !isPlacementOk(el, node)) {
          node.remove();
          applyWithFallback(el, node, strategies, index + 1);
        }
      });
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
      if (!el.isConnected || textOfBlock(el) !== original) {
        // stale 时清理可能存在的半截流式译文，避免错误内容滞留 8 秒
        dropTranslationNode(el);
        return 'stale';
      }
      if (!translation || translation === original) {
        markTranslated(el);
        return 'skipped';
      }
      insertTranslation(el, translation, original);
      markTranslated(el);
      // 第 10 轮：重试成功后清除失败标记（保留会给整页完成文案误报失败数）。
      el.removeAttribute('data-retryable');
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
      if (outcome === 'inserted') {
        translatedCount++;
        refreshToolbarIdleLabels();
      }
      return outcome !== 'stale';
    }

    // 状态提示（"翻译中…" / "已翻译 N 段"），紧贴悬浮按钮上方
    let statusEl: HTMLElement | null = null;
    let statusTimer: ReturnType<typeof setTimeout> | null = null;
    function progressText(): string {
      return pageTotalFound > 0 ? `${translatedCount}/${pageTotalFound}` : String(translatedCount);
    }

    function showStatus(text: string, transient = false, durationMs = 2000) {
      if (!statusEl) {
        statusEl = document.createElement('div');
        statusEl.id = 'ot-status';
        statusEl.setAttribute('role', 'status');
        statusEl.setAttribute('aria-live', 'polite');
        // 玻璃材质与主题色：此前状态条写死为深色（rgba(28,28,30,0.86)），
        // 在浅色网页上突兀且与其余浮层不是同一种材质。改为跟随主题的玻璃胶囊。
        const st = themeColors();
        Object.assign(statusEl.style, {
          position: 'fixed',
          right: '20px',
          bottom: '78px',
          zIndex: '2147483646',
          background: st.surface,
          color: st.text,
          backdropFilter: st.backdrop,
          WebkitBackdropFilter: st.backdrop,
          border: `0.5px solid ${st.border}`,
          font: '12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          padding: '7px 12px',
          borderRadius: '11px',
          pointerEvents: 'none',
          boxShadow: `${st.highlight}, ${st.shadow}`,
          opacity: '0',
          transition: 'opacity 0.2s ease, transform 0.2s ease',
          maxWidth: '300px',
          whiteSpace: 'normal',
          // 左对齐：整页完成文案（含「· 约省 N Token · 滚动时继续 · 主引擎不可用…」
          // 等多段拼接）较长，右对齐在多行时右侧参差难读。
          textAlign: 'left',
          overflowWrap: 'break-word',
        });
        document.documentElement.appendChild(statusEl);
      }
      statusEl.textContent = text;
      statusEl.style.opacity = '1';
      if (statusTimer) clearTimeout(statusTimer);
      if (transient) {
        statusTimer = setTimeout(() => {
          if (statusEl) statusEl.style.opacity = '0';
        }, durationMs);
      }
    }
    function hideStatus() {
      if (statusEl) statusEl.style.opacity = '0';
    }

    // 降级提示：实际成功引擎 ≠ 用户配置的主引擎时，一次性说明「已自动切换」，
    // 避免用户看到译文却以为还在用自己的模型（质量/价格预期错位）。
    // 只提示一次：同一会话内后续降级不重复打扰（noticeCycles 语义类似）。
    // 单条交互立即弹状态；整页翻译则记录到完成文案里（否则会被「已翻译 N 段」覆盖）。
    let fallbackNotified = false;
    let currentFallbackName = '';
    function maybeNotifyFallback(providerId: string | undefined) {
      if (!providerId || fallbackNotified) return;
      // currentProvider 为 ''（配置尚未同步）时无法判断是否降级，不提示；
      // 已同步且实际引擎等于主引擎 → 正常路径，不提示。
      if (currentProvider && providerId === currentProvider) return;
      const name = PROVIDERS.find((p) => p.id === providerId)?.name || providerId;
      fallbackNotified = true;
      currentFallbackName = name;
      // 整页翻译进行中：降级说明合并到最终完成提示，避免瞬时弹窗被覆盖。
      // 单条交互（划词/悬停/手动）不在整页任务中，直接弹一次性提示。
      if (!busy) {
        showStatus(`主引擎不可用，已切换至 ${name} 翻译`, true, 4000);
      }
    }
    function fallbackSuffix(): string {
      return fallbackNotified ? ` · 主引擎不可用，已用 ${currentFallbackName} 翻译` : '';
    }

    // ===== 翻译清理：移除所有已插入的译文节点 + 清除标记 =====
    // 这是解决"多次点击导致译文堆叠"的核心：每次整页翻译前先彻底清理上一次的残留。
    // ===== 译文显隐切换（0 Token）：临时看原文 / 看译文 =====
    // 动机：此前想「只看原文」只能点收起（clearTranslations）——译文被删除，
    // 再想看译文必须整页重译，等于同一批内容重复付费。改用纯 CSS 显隐，
    // 来回切换不产生任何请求，也保留已翻译结果。
    let translationsHidden = false;

    function setTranslationsHidden(hidden: boolean, skipNodes = false): void {
      translationsHidden = hidden;
      // 根节点 class 作为状态标记（供样式与测试判定）。
      document.documentElement.classList.toggle('ot-hide-translations', hidden);
      // 必须逐个改内联样式：译文节点自身带 display:block !important，
      // 外部样式表的 !important 无法覆盖内联 !important，只能以同级内联覆盖。
      // 节点数通常几十~几百，偶发切换的遍历开销可忽略（远小于一次翻译请求）。
      // skipNodes=true（clearTranslations 路径）：节点即将被整体删除，遍历改
      // display 纯属浪费，还会先「闪一下可见」再删——用户感知为闪烁。
      if (!skipNodes) {
        document.querySelectorAll('.ot-translation').forEach((el) => {
          (el as HTMLElement).style.setProperty(
            'display',
            hidden ? 'none' : 'block',
            'important',
          );
        });
      }
      const btn = document.getElementById('ot-hide-btn');
      if (btn) {
        // 图标保持不变（眼睛），显隐状态由 title / aria-label / aria-pressed / 透明度表达
        btn.title = hidden ? '显示译文（快捷键 Alt+S）' : '隐藏译文（快捷键 Alt+S）';
        btn.setAttribute('aria-label', btn.title);
        btn.setAttribute('aria-pressed', hidden ? 'true' : 'false');
        btn.style.opacity = hidden ? '0.45' : '1';
      }
    }

    function toggleTranslations(): void {
      // 人体工学：页面还没有任何译文时，隐藏按钮/快捷键点击是无效动作——
      // 直接进隐藏态会让按钮变暗（opacity 0.45）却没有可隐藏内容，用户困惑。
      // 此时给出明确引导（0.2.10 优化空态交互）。
      if (document.querySelectorAll('.ot-translation').length === 0) {
        if (!translationsHidden) {
          showStatus('页面上还没有译文，先点「译」翻译本页', true, 2200);
          return;
        }
        // translationsHidden 为 true 但无译文节点（异常/已被外部清除）：复位状态。
        setTranslationsHidden(false);
        return;
      }
      setTranslationsHidden(!translationsHidden);
      showStatus(translationsHidden ? '已隐藏译文（再按 Alt+S 恢复，不会重新翻译）' : '已显示译文', true, 2200);
    }

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
      // 第 17 轮：收起全部译文 = 一次性「我要看原文」的动作。隐藏态必须一并复位，
      // 否则「收起 → 再点翻译」时新译文全部处于隐藏态，用户以为翻译没生效。
      // skipNodes=true：节点即将被删除，无需遍历改 display（避免闪烁）。
      if (translationsHidden) setTranslationsHidden(false, true);
      // 移除所有译文节点（核心：防止多次点击叠加）
      document.querySelectorAll('.ot-translation').forEach((el) => el.remove());
      // 清除所有已翻译标记（让 collectTextBlocks 可重新收集）
      document
        .querySelectorAll(`.${TRANSLATED_CLASS}`)
        .forEach((el) => (el as HTMLElement).classList.remove(TRANSLATED_CLASS));
      // 第 10 轮：清除失败重试标记（收起全部译文时一并复位，避免残留脏标记）
      document
        .querySelectorAll('[data-retryable="true"]')
        .forEach((el) => el.removeAttribute('data-retryable'));
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
      // 计数清零后工具栏提示回到「翻译本页」（busy 时由加载态文案接管）。
      refreshToolbarIdleLabels();
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
      // 任务已被不可重试错误封锁：清空懒队列并停止入队，避免滚动持续触发
      // 「入队 → 规划 → 入口被弹掉」的空转循环。
      if (blockedPageJobId === jobId) {
        stopLazyTranslation();
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
          showStatus(`已翻译 ${progressText()} 段${savedText}${failureText}${fallbackSuffix()} · 滚动时继续`, true);
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
            maybeNotifyFallback(typeof r.usedProvider === 'string' ? r.usedProvider : undefined);
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
      refreshToolbarIdleLabels();
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
              usedProvider?: string;
              error?: string;
            }
          | undefined;
        if (jobId && activePageJobId !== jobId) return;
        if (!res?.ok) throw new Error(res?.error || '翻译失败');
        maybeNotifyFallback(res.usedProvider);
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
        refreshToolbarIdleLabels();
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
              // 第 10 轮：失败段落标记可重试，提示用户可点击重译（手动模式点击段落
              // 会重新走 manualTranslateBlock；自动模式滚动到视口自动重试）。
              (item.el as HTMLElement).dataset.retryable = 'true';
              return true;
            })
          : [];
        if (retryable.length > 0) {
          setTimeout(() => {
            if (!jobId || activePageJobId === jobId) observeForLazyTranslation(retryable);
          }, 500);
        }
        // 第 10 轮：失败原因以状态条呈现（重试入口可见），不再只弹模态打断阅读。
        // 整页完成提示会附带「N 段失败」统计（见 translatePage 完成文案）。
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
      const mySeq = ++pageRunSeq;
      const cancelled = () => pageCancelSeq >= mySeq;
      // 只有当本代仍是最新任务时才能复位交互状态；若已有更新的任务接管，一律不动。
      const ownedByMe = () => pageRunSeq === mySeq;

      // 引擎/Key 还没配好：一个请求都不发，直接给引导。
      // 用户主动点翻译时强制展示（点了没反应更困惑），自动翻译时只打扰一次。
      if (await needsSetupNow()) {
        busy = false;
        awaitingSetup = true;
        showSetupGuide(userInitiated);
        return;
      }
      // await 期间用户点了「取消」或站点被暂停：就此收尾，不再继续启动序列。
      if (siteDisabled && ownedByMe()) {
        busy = false;
        setToolbarLoading(false);
        showSitePausedNotice();
        return;
      }
      if (cancelled()) {
        if (ownedByMe()) {
          busy = false;
          setToolbarLoading(false);
        }
        return;
      }

      // 手动模式仅控制「页面加载时是否自动翻译」。
      // 用户主动点击工具栏 / 快捷键 / 弹窗 = 明确要求翻译，不受模式限制。
      if (!effectiveAutoMode() && !userInitiated) {
        busy = false;
        return;
      }

      let jobId: string | null = null;
      try {
        // 先清理旧译文层，防止堆叠
        clearTranslations();
        jobId = randomId();
        if (cancelled()) {
          busy = false;
          setToolbarLoading(false);
          return;
        }
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
          // 第 10 轮：失败段明确提示数量与重试方式（滚动到视口自动重试 /
          // 手动模式点击段落重试），不再让用户面对「明明有译文却少了几个」的困惑。
          const retryHint =
            document.querySelectorAll('[data-retryable="true"]').length > 0
              ? '，滚动或点击失败段落可重试'
              : '';
          showStatus(
            `已翻译 ${progressText()} 段，${failures} 个批次失败${retryHint}${fallbackSuffix()}`,
            true,
          );
        } else if (translatedCount === 0) {
          const savedText =
            estimatedTokensSaved > 0 ? `，本地约省 ${estimatedTokensSaved} Token` : '';
          showStatus(`无需翻译（内容已为目标语言）${savedText}${fallbackSuffix()}`, true);
        } else {
          const savedText = estimatedTokensSaved > 0 ? ` · 约省 ${estimatedTokensSaved} Token` : '';
          const lazyText = deferredCount > 0 ? ' · 滚动时继续' : '';
          showStatus(`已翻译 ${progressText()} 段${savedText}${lazyText}${fallbackSuffix()}`, true);
        }
      } catch (e: any) {
        showNotice(e?.message || '翻译失败', jobId || 'page-translation');
      } finally {
        // 取消后用户可能已经开始了新任务。旧任务的异步收尾不能清掉新任务的
        // busy / 按钮状态，也不能替新任务提前启动动态监听。
        if (cancelled() && ownedByMe()) {
          // 本任务被用户取消：复位交互状态，但不启动动态监听。
          busy = false;
          setToolbarLoading(false);
        } else if (activePageJobId === jobId) {
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
      if (!effectiveAutoMode()) return;
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
        if (translation?.isConnected) {
          translatedCount = Math.max(0, translatedCount - 1);
          refreshToolbarIdleLabels();
        }
        translation?.remove();
        translationNodes.delete(element);
        const classes = (element as HTMLElement).classList;
        classes?.remove(PENDING_CLASS, OBSERVED_CLASS, TRANSLATED_CLASS);
        element.removeAttribute('data-retryable');
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
      // 元素 → 各自的到期时间。此前是共享 Set + 单一定时器：后加入的元素被迫
      // 跟随最早入队者的期限，最多晚一个完整冷却周期才刷新。
      // cooldownDeadlines 与 cooldownTimer 声明在模块级（stopDynamic 清理用）。

      // 带符号的数字 token：符号是数值的一部分（-5.2 与 5.2 是不同的值），
      // 百分号跟随数值。骨架比对与就地补数共用同一套 token 定义，
      // 保证「只有符号在变」不会被误判成「只是数字在动」。
      const DYNAMIC_NUMBER_RE = /[-+]?\d+(?:[.,]\d+)*%?/g;

      // 抹掉数字 token 后的「文字骨架」：骨架相同即认为句子没变，只是数值在动。
      // 注意不能把 +/-/% 等符号连同数字一起抹掉——否则 -5.2% → 5.2%、50% → 50
      // 这类符号变化会被当成纯数值更新吞掉，过期译文永久滞留。
      const digitSkeleton = (text: string) =>
        text.replace(DYNAMIC_NUMBER_RE, ' ').replace(/\s+/g, ' ').trim();

      // 把译文里的旧数字按出现顺序替换成新数字。任何一处对不上就整体放弃，
      // 宁可继续显示旧译文，也绝不拼出错误的数字。
      const patchTranslationNumbers = (
        node: HTMLSpanElement,
        prev: string,
        next: string,
      ): boolean => {
        const before = prev.match(DYNAMIC_NUMBER_RE) || [];
        const after = next.match(DYNAMIC_NUMBER_RE) || [];
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

      const armCooldownTimer = () => {
        if (cooldownTimer) return;
        let minDeadline = Number.POSITIVE_INFINITY;
        cooldownDeadlines.forEach((deadline) => {
          if (deadline < minDeadline) minDeadline = deadline;
        });
        if (!Number.isFinite(minDeadline)) return;
        // 至少 200ms：把同一轮抖动的多次入队合并成一次唤醒。
        cooldownTimer = setTimeout(flushCooldownQueue, Math.max(200, minDeadline - Date.now()));
      };

      const flushCooldownQueue = () => {
        cooldownTimer = null;
        const now = Date.now();
        Array.from(cooldownDeadlines.entries()).forEach(([anchor, deadline]) => {
          if (deadline > now) return;
          cooldownDeadlines.delete(anchor);
          if (anchor.isConnected) refreshChangedText(anchor);
        });
        // 队列里还有未到期元素（比首个期限更晚入队）→ 按下一个最近期限继续等。
        if (cooldownDeadlines.size > 0) armCooldownTimer();
      };

      const queueAfterCooldown = (anchor: Element, waitMs: number) => {
        cooldownDeadlines.set(anchor, Date.now() + Math.max(200, waitMs));
        armCooldownTimer();
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
            if (node.nodeType !== Node.ELEMENT_NODE) {
              if (node.nodeType === Node.TEXT_NODE) parentTextChanged = true;
              return;
            }
            const el = node as Element;
            // 自身注入的节点（译文/状态/工具栏/图片面板）被我们自己移除时不当作
            // 页面内容变化，否则每次清理译文都会触发一次 +8s 的幽灵重译唤醒。
            if (
              el.closest?.(
                '#ot-error-modal, .ot-translation, .ot-img-panel, .ot-img-seg, #ot-toolbar, #ot-status, .ot-selbtn',
              )
            )
              return;
            // SPA 框架的「移动」= 同步 remove + insert，回调执行时节点往往已经
            // 重新连接。这是移动而非删除：跟随搬迁译文节点即可，不要 release——
            // 否则列表排序/虚拟滚动时会出现译文闪烁与重复请求。
            if (el.isConnected) {
              const moved = translationNodes.get(el);
              if (moved && !moved.isConnected && !el.closest('.ot-translation')) {
                try {
                  el.insertAdjacentElement('afterend', moved);
                } catch {
                  /* 插入失败则交给后续重扫兜底 */
                }
              }
              return;
            }
            if (!closestTextBlock(el, true)) parentTextChanged = true;
            releaseRemovedSubtree(el);
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
      // 改为只扫描 display:none → visible 切换的元素（通过检查可见性变化来发现新内容）。
      // 防抖窗口内收集全部点击目标：此前闭包只保留最后一个 target，
      // 快速连点不同区域时前面的子树永远不会被扫描。
      dynamicClickHandler = (e: Event) => {
        const target = e.target as Element | null;
        if (!target || target.nodeType !== 1) return;
        if (!clickTargets) clickTargets = new Set();
        clickTargets.add(target as Element);
        if (dynamicClickTimer) clearTimeout(dynamicClickTimer);
        dynamicClickTimer = setTimeout(() => {
          dynamicClickTimer = null;
          const targets = Array.from(clickTargets ?? []);
          clickTargets = null;
          if (!dynamicActive || targets.length === 0) return;
          // 全页点击（点到 body / html 本身）直接交给 MutationObserver，不再整页重扫；
          // 只对点击元素子树做有界扫描，避免每次点击都遍历整棵 DOM 造成卡顿
          //（回归 0.1.0 修复前的“翻译变慢”问题）。Portal 菜单 / 显隐切换由 MutationObserver 接管。
          const roots: Element[] = [];
          for (const target of targets) {
            if (target === document.body || target === document.documentElement) continue;
            if (roots.includes(target)) continue;
            roots.push(target);
            const control = target.closest('[aria-controls], [aria-owns]');
            if (!control) continue;
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
                  UI_SURFACE_SELECTOR,
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
      clickTargets = null;
      if (dynamicQueueTimer) clearTimeout(dynamicQueueTimer);
      dynamicQueueTimer = null;
      dynamicRoots.clear();
      cooldownDeadlines.clear();
      if (cooldownTimer) clearTimeout(cooldownTimer);
      cooldownTimer = null;
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
        // 站点暂停时停止动态观察：MutationObserver 继续监听 body 只会空转
        // 浪费 CPU（此前遗漏，暂停的站点仍会被 characterData/childList 突变唤醒）。
        // mountedToolbar 由恢复分支重新 mount，动态翻译在恢复时重新启动。
        stopDynamic();
      } else {
        noticeCycles.release('site-paused');
        mountToolbar();
        // 恢复翻译时若处于自动模式，重新启动动态内容观察（暂停前的观察已断开）。
        startDynamicTranslation();
      }
    }

    function showSitePausedNotice() {
      // 固定 cycle id：同一轮提示期内重复触发（右键/自动翻译/图片结果）只弹一次，
      // 用 randomId 会让 NoticeCycleGate 永远放行、反复闪屏。
      showNotice('当前网站已暂停翻译，请在扩展弹窗中恢复', 'site-paused');
    }

    // ===== 0.2.2 网站规则：白名单（始终翻译）/ 敏感页面（从不翻译）=====
    // 优先级：敏感(never) > 暂停(disabledSites) > 白名单(always，强制自动翻译)。
    // 页面启动时与站内规则切换时调用；首启动时由 sitePolicyReady 链兜底。
    // 直接策略消息（SITE_POLICY_CHANGED，background 权威判定）会 sitePolicyRevision++，
    // 因此本函数在异步读取列表前快照 revision，读取后若 revision 已变则放弃应用——
    // 避免用旧列表覆盖掉更新、更权威的暂停/恢复指令。
    let refreshSiteRulesRunning = false;
    async function refreshSiteRules(revisionAnchor?: number) {
      if (refreshSiteRulesRunning) return;
      refreshSiteRulesRunning = true;
      // 快照基准：默认取调用时 revision；sitePolicyReady 链启动时传入链起始值
      //（initialSitePolicyRevision），把「消息在列表读取期间到达」也视为竞态——
      // 否则陈旧列表会覆盖掉消息设置的权威暂停/恢复。
      const revisionAtStart = revisionAnchor ?? sitePolicyRevision;
      try {
        const [always, never, disabledSites, autoSites] = await Promise.all([
          alwaysSitesItem.getValue(),
          neverSitesItem.getValue(),
          disabledSitesItem.getValue(),
          autoSitesItem.getValue(),
        ]);
        if (sitePolicyRevision !== revisionAtStart) return; // 期间有更新的权威指令，放弃本次
        // 敏感页面优先：从不在列表 => 一律暂停（即使白名单命中也被覆盖）
        if (isNeverSite(never, location.href)) {
          setSiteDisabledState(true);
          return;
        }
        // 白名单 => 强制自动翻译；否则维持暂停/自动列表判定
        const alwaysOn = isAlwaysSite(always, location.href);
        if (alwaysOn) {
          thisSiteAutoOverride = true;
          setSiteDisabledState(false);
          // 白名单已译/未译：若尚未翻译且当前处于手动模式，也直接触发整页翻译
          if (!document.querySelector('.ot-translation')) {
            void translatePage(true);
          }
          return;
        }
        // 非白名单：恢复全局模式与站点自动列表判定
        const autoOn = autoSites === null || isSiteDisabled(autoSites, location.href);
        thisSiteAutoOverride = Array.isArray(autoSites) && isSiteDisabled(autoSites, location.href);
        if (!isNeverSite(never, location.href)) {
          setSiteDisabledState(isSiteDisabled(disabledSites, location.href));
        }
        if (autoOn && !siteDisabled && !document.querySelector('.ot-translation') && effectiveAutoMode()) {
          void translatePage(true);
        }
      } catch {
        /* 规则读取失败时保持现状 */
      } finally {
        refreshSiteRulesRunning = false;
      }
    }

    // ===== 0.2.2 对照模式悬停恢复：事件委托 =====
    // 译文节点实际插在原文「之后」（afterend）或「内部」（appendChild），CSS 的
    // `+` / `~` 兄弟选择器只能向后匹配，无法从译文选中其前面的原文。改用事件
    // 委托（捕获阶段冒泡到 document）实现：
    //   - translation-only：悬停译文 → 临时显示其锚点原文；离开恢复隐藏。
    //   - hover-original：悬停译文 → 高亮其锚点原文；离开取消高亮。
    // 锚点从节点上的 otAnchor 反查（insertTranslation 挂载），无锚点则跳过。
    // translation-only：hover 类恢复原文（opacity 规则）；hover-original：active 类高亮原文背景。
    function bindDualModeHover() {
      document.addEventListener(
        'mouseover',
        (event) => {
          const target = (event.target as HTMLElement | null)?.closest?.('.ot-translation');
          if (!target) return;
          const anchor = (target as HTMLSpanElement & { otAnchor?: Element }).otAnchor;
          if (!anchor || !anchor.isConnected) return;
          const host = anchor as HTMLElement;
          if (currentDualMode === 'translation-only') {
            host.classList.add('ot-dual-source-hover');
            applyDualHover(anchor, true);
          } else if (currentDualMode === 'hover-original') {
            host.classList.add('ot-dual-source-hover-active');
            applyDualHover(anchor, true);
          }
        },
        true,
      );
      document.addEventListener(
        'mouseout',
        (event) => {
          const target = (event.target as HTMLElement | null)?.closest?.('.ot-translation');
          if (!target) return;
          const anchor = (target as HTMLSpanElement & { otAnchor?: Element }).otAnchor;
          if (!anchor || !anchor.isConnected) return;
          const host = anchor as HTMLElement;
          host.classList.remove('ot-dual-source-hover', 'ot-dual-source-hover-active');
          applyDualHover(anchor, false);
        },
        true,
      );
    }
    bindDualModeHover();

    // ---- 划词翻译：结果留在独立浮层中，不改写正文，也不会覆盖整段译文。 ----
    type SelectionSnapshot = { text: string; rect: DOMRect };
    let selectionHost: HTMLDivElement | null = null;
    let selectionPinned = false;
    let selectionTimer: ReturnType<typeof setTimeout> | null = null;
    let selectionRequestId = 0;
    let activeSelectionJobId: string | null = null;
    // 面板定位时的滚动基准：固定态滚动时按差量平移面板，保持与选区对齐。
    let selectionAnchorScroll = { x: 0, y: 0 };

    function hideSelectionUi() {
      selectionRequestId++;
      stopSpeaking();
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
        start.closest(UI_SURFACE_SELECTOR,)
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
      // 记录定位时的滚动基准：后续滚动按差量平移面板（固定态跟随）。
      selectionAnchorScroll = { x: window.scrollX, y: window.scrollY };
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
      // 注入 Liquid Glass 主题变量：CSS 自定义属性会继承进 Shadow DOM，
      // 划词浮层样式表（createSelectionUiStyle）直接消费 --ot-*，深浅色随之统一。
      applyThemeVars(host, themeColors());
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
      opts?: { localSkipped?: boolean },
    ) {
      const shadow = host.shadowRoot!;

      // 原地更新：面板已在展示 loading 时只替换结果文本并追加操作行，
      // 避免完成瞬间重播入场动画造成视觉闪烁。
      const existingPanel = shadow.querySelector('.panel');
      const existingResult = shadow.querySelector('.result');
      if (existingPanel && existingResult && existingResult.classList.contains('loading') && translation !== undefined) {
        existingResult.textContent = translation;
        existingResult.classList.remove('loading');
        if (opts?.localSkipped) {
          const hint = document.createElement('div');
          hint.className = 'skip-hint';
          hint.textContent = '原文已是目标语言，未翻译';
          existingPanel.appendChild(hint);
        }
        const actions = document.createElement('div');
        actions.className = 'actions';
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'action';
        copyBtn.textContent = '复制';
        copyBtn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(translation);
            copyBtn.textContent = '已复制';
            setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = '复制'; }, 1200);
          } catch { copyBtn.textContent = '复制失败'; }
        });
        actions.appendChild(createSpeakButton(() => translation, () => currentTargetLang));
        actions.appendChild(copyBtn);
        existingPanel.appendChild(actions);
        return;
      }

      // 首次创建：完整构建面板
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
        // 本地跳过提示：译文与原文相同不再让用户怀疑「翻译没生效」。
        if (opts?.localSkipped) {
          const hint = document.createElement('div');
          hint.className = 'skip-hint';
          hint.textContent = '原文已是目标语言，未翻译';
          panel.appendChild(hint);
        }
        const actions = document.createElement('div');
        actions.className = 'actions';
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'action';
        copy.textContent = '复制';
        copy.addEventListener('click', async () => {
          // 空译文（流式中/失败占位）复制空串无意义，给明确提示而非静默成功。
          if (!translation) {
            copy.textContent = '没有可复制的内容';
            setTimeout(() => {
              if (copy.isConnected) copy.textContent = '复制';
            }, 1200);
            return;
          }
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
        const speakBtn = createSpeakButton(() => translation, () => currentTargetLang, { getVoiceName: () => currentTtsVoice });
        speakBtn.className = 'action';
        speakBtn.style.minHeight = '28px';
        actions.appendChild(speakBtn);
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
        // 「原文已是目标语言」的跳过结果不进会话缓存：缓存通道只存字符串、
        // 会丢失 localSkipped 标志，导致第二次起提示消失（困惑回归）。
        if (!res.localSkipped) {
          // 历史记录独立于配置版本；会话缓存仍要求配置未中途变化。
          void addHistoryEntry({
            text: snapshot.text,
            translation,
            source: 'selection',
          });
          if (requestConfigRevision === translationConfigRevision) {
            sessionTranslations.remember(snapshot.text, translation);
          }
        }
        renderSelectionPanel(host, snapshot, translation, {
          localSkipped: res.localSkipped === true,
        });
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
        if (!selectionPinned) {
          hideSelectionUi();
          return;
        }
        // 固定态：面板随页面滚动平移，保持与选区原文对齐。
        const host = selectionHost;
        if (!host || !host.isConnected) return;
        const dx = window.scrollX - selectionAnchorScroll.x;
        const dy = window.scrollY - selectionAnchorScroll.y;
        if (!dx && !dy) return;
        selectionAnchorScroll = { x: window.scrollX, y: window.scrollY };
        const curLeft = parseFloat(host.style.left) || 0;
        const curTop = parseFloat(host.style.top) || 0;
        host.style.setProperty('left', `${curLeft + dx}px`, 'important');
        host.style.setProperty('top', `${curTop + dy}px`, 'important');
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
        // 跳过结果不进会话缓存（缓存通道会丢 localSkipped 标志）。
        if (!r.localSkipped) sessionTranslations.remember(text, r.translation);
        const outcome = applyTranslation(el, text, r.translation);
        // 手动路径同样计数：否则工具栏「收起全部译文」的 title/aria 与实际行为相反。
        if (outcome === 'inserted') {
          translatedCount++;
          refreshToolbarIdleLabels();
        }
      } catch (error) {
        // 失败不再完全静默：给出原因便于排查；半截流式译文必须撤掉
        if (streamedPartial) dropTranslationNode(el);
        const msg = error instanceof Error ? error.message : String(error);
        if (!/取消|abort/i.test(msg)) showStatus(`翻译失败：${msg}`, true, 4000);
      } finally {
        html.classList.remove(PENDING_CLASS);
      }
    }

    // 手动模式下：点击正文段落触发翻译；有划词选区时不干扰选区。
    document.addEventListener(
      'click',
      (e: Event) => {
        if (effectiveAutoMode() || siteDisabled) return;
        const target = e.target as Element | null;
        if (!target) return;
        // composedPath 穿透 Shadow DOM：点击自有浮层（悬停气泡按钮/设置面板等）
        // 不得触发段落翻译（closest 穿不过 shadow root 会漏判成网页内容）。
        const path = e.composedPath() as EventTarget[];
        if (hoverBubble && path.includes(hoverBubble.host)) return;
        if (
          target.closest(
            UI_SURFACE_SELECTOR,
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
    runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
      if (msg?.type === 'SITE_POLICY_CHANGED' && typeof msg.payload?.disabled === 'boolean') {
        sitePolicyRevision++;
        setSiteDisabledState(msg.payload.disabled);
        return;
      }
      // 快捷键 Alt+S / 工具栏眼睛按钮：切换译文显隐（0 请求，不重新翻译）。
      if (msg?.type === 'TOGGLE_TRANSLATIONS') {
        toggleTranslations();
        return;
      }
      if (msg?.type === 'TRANSLATE_PAGE') {
        // 向调用方（popup）回传真实结果：手动模式 / 已暂停不再被误报为成功。
        void sitePolicyReady.then(() => {
          if (siteDisabled) {
            showSitePausedNotice();
            sendResponse({ ok: false, reason: 'paused' });
            return;
          }
          void translatePage(true, true);
          sendResponse({ ok: true });
        });
        return true; // 异步应答
      }
      if (msg?.type === 'SHOW_IMAGE_RESULT') {
        if (siteDisabled) showSitePausedNotice();
        else showImageResult(msg.payload?.srcUrl, msg.payload?.result);
        return;
      }
      if (msg?.type === 'SHOW_ERROR') {
        showNotice(msg.payload?.message || '操作失败', `external-${randomId()}`);
        return;
      }
      if (msg?.type === 'TRANSLATE_SELECTION') {
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

    // 快速设置面板的全局关闭监听（点击面板外 / Esc），随关闭一起移除。
    let settingsDismiss: (() => void) | null = null;
    // 打开代际号：openSettingsPanel 是 async（前置多次存储读取），快速双击齿轮时
    // 两次调用会并发执行——没有守卫的话先完成的 host 会失去引用成为孤儿面板，
    // 永远无法被 closeSettingsPanel 移除。
    let settingsPanelSeq = 0;

    function closeSettingsPanel() {
      settingsDismiss?.();
      settingsDismiss = null;
      settingsPanel?.host.remove();
      settingsPanel = null;
    }

    // ===== 页面内完整设置大面板（网页中央弹窗） =====
    let fullSettingsHost: HTMLElement | null = null;
    let fullSettingsFormApi: ReturnType<typeof buildConfigForm> | null = null;
    // 表单构建代际号：防止「关闭→重开」竞态下旧异步构建覆盖新面板的 formApi。
    let fullSettingsBuildSeq = 0;
    let fullSettingsEsc: ((e: KeyboardEvent) => void) | null = null;
    let fullSettingsWheelLock: ((e: WheelEvent) => void) | null = null;
    let fullSettingsTouchLock: ((e: TouchEvent) => void) | null = null;

    function closeFullSettings() {
      // 使在途的异步表单构建失效（代际号推进）
      fullSettingsBuildSeq++;
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
      fullSettingsFormApi?.dispose();
      fullSettingsHost?.remove();
      fullSettingsHost = null;
      fullSettingsFormApi = null;
    }

    // 按表单里实际存在的分组标题生成吸顶导航（不写死文案：
    // ui.ts 增删分组时导航自动跟随，不会出现"导航有、内容没有"的错位）。
    function buildSettingsNav(nav: HTMLElement, mount: HTMLElement) {
      nav.replaceChildren();
      const sections = Array.from(mount.querySelectorAll<HTMLElement>('.ot-form-section'));
      for (const section of sections) {
        const label = section.querySelector('h2, summary')?.textContent?.trim();
        if (!label) continue;
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'ot-settings-nav-item';
        item.textContent = label;
        item.addEventListener('click', () => {
          section.scrollIntoView({ block: 'start', behavior: 'smooth' });
        });
        nav.appendChild(item);
      }
      nav.hidden = nav.childElementCount === 0;
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
          /* 只保留一个 max-height：原先后一条 calc(100vh - 48px) 覆盖了
             min(80vh, 720px)，等于没有高度上限，长表单会把面板拉到贴边。 */
          max-height: min(80vh, 720px);
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
        /* 分组快捷导航：单列列表后内容约 4 屏高，顶部吸顶便于直接跳转 */
        .ot-settings-nav {
          position: sticky; top: 0; z-index: 3;
          display: flex; flex-wrap: wrap; gap: 6px;
          margin: 0 -6px 10px; padding: 8px 6px;
          background: ${theme.surface};
          backdrop-filter: ${theme.backdrop};
          -webkit-backdrop-filter: ${theme.backdrop};
          border-bottom: 1px solid ${theme.hairline};
        }
        .ot-settings-nav[hidden] { display: none; }
        .ot-settings-nav-item {
          padding: 5px 11px;
          border: 0; border-radius: 999px;
          background: ${theme.surface2}; color: ${theme.text2};
          font-family: inherit; font-size: 12.5px; font-weight: 600;
          white-space: nowrap; cursor: pointer;
          transition: background 0.15s ease, color 0.15s ease;
        }
        .ot-settings-nav-item:hover {
          color: ${theme.text};
          background: ${theme.accentSoft};
        }
        .ot-settings-nav-item:focus-visible {
          outline: 2px solid ${theme.accentSoft}; outline-offset: 1px;
        }
        /* 抵消吸顶导航的高度，跳转后分组标题不被遮住 */
        .ot-form-section { scroll-margin-top: 60px; }
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
      // 分组快捷导航：表单项是异步构建的，所以先占位、构建完成后再按实际分组标题填充
      const nav = document.createElement('nav');
      nav.className = 'ot-settings-nav';
      nav.setAttribute('aria-label', '设置分组');
      nav.hidden = true;
      const mount = document.createElement('div');
      body.append(nav, mount);
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
      // 面板内部滚动不受影响。Shadow DOM 会把事件 target 重定向为宿主元素，
      // 必须用 composedPath 拿到 shadow 内的真实目标才能正确判断。
      const inModal = (e: Event) => {
        return (e.composedPath() as EventTarget[]).includes(modal);
      };
      fullSettingsWheelLock = (e: WheelEvent) => {
        if (!inModal(e)) e.preventDefault();
      };
      fullSettingsTouchLock = (e: TouchEvent) => {
        if (!inModal(e)) e.preventDefault();
      };
      window.addEventListener('wheel', fullSettingsWheelLock, true);
      window.addEventListener('touchmove', fullSettingsTouchLock, true);

      // 样式直接来自打包进内容脚本的 options.css（?raw），不依赖网络。
      const sheet = document.createElement('style');
      sheet.textContent = fullSettingsCss
        .replace(/:root/g, ':host')
        .replace(/\bbody\b/g, '.ot-full-settings-body');
      shadow.prepend(sheet);

      // 站点偏好初始状态。代际守卫：面板可能在存储读取期间被关闭又重开，
      // 旧 IIFE 恢复后不得覆盖新面板的 formApi（否则关闭时 dispose 的是死对象，
      // 活表单的监听永远不被退订）。
      const buildSeq = ++fullSettingsBuildSeq;
      void (async () => {
        const [disabledSites, autoSites] = await Promise.all([
          disabledSitesItem.getValue(),
          autoSitesItem.getValue(),
        ]);
        if (buildSeq !== fullSettingsBuildSeq) return;
        try {
          fullSettingsFormApi = buildConfigForm(mount, false, {
            host: location.host,
            // 与自动翻译运行时判断（autoSites === null || ...）保持同一语义：
            // null = 从未配置 = 默认自动翻译。漏掉前缀会让开关显示与实际行为相反。
            autoTranslate: autoSites === null || isSiteDisabled(autoSites, location.href),
            paused: isSiteDisabled(disabledSites, location.href),
            // 0.2.2 网站规则：始终翻译白名单 / 敏感页面排除
            always: isAlwaysSite(await alwaysSitesItem.getValue(), location.href),
            never: isNeverSite(await neverSitesItem.getValue(), location.href),
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
            onAlways: (enabled) => {
              enqueueSettingsWrite(async () => {
                const sites = await alwaysSitesItem.getValue();
                await alwaysSitesItem.setValue(withAlwaysSite(sites, location.href, enabled));
                // 白名单变化立即影响本站自动翻译判定
                refreshSiteRules();
              });
            },
            onNever: (enabled) => {
              enqueueSettingsWrite(async () => {
                const sites = await neverSitesItem.getValue();
                await neverSitesItem.setValue(withNeverSite(sites, location.href, enabled));
                refreshSiteRules();
              });
            },
          });
          buildSettingsNav(nav, mount);
        } catch {
          // 表单构建失败：面板保留头部与关闭按钮，不崩溃内容脚本
          mount.textContent = '设置加载失败，请重新打开';
          mount.style.cssText = 'padding:12px;font-size:13px;color:#ff3b30;';
        }
      })();
    }

    async function openSettingsPanel(anchorX: number, anchorY: number, anchorTop = anchorY) {
      const mySeq = ++settingsPanelSeq;
      closeSettingsPanel();
      try {
        const cfg = normalizeConfig(await configItem.getValue());
        // await 期间可能已有更新的一次打开（或被关闭）：放弃本次结果，防孤儿面板。
        if (mySeq !== settingsPanelSeq) return;
        const [disabledSites, autoSites, alwaysSites, neverSites] = await Promise.all([
          disabledSitesItem.getValue(),
          autoSitesItem.getValue(),
          alwaysSitesItem.getValue(),
          neverSitesItem.getValue(),
        ]);
        if (mySeq !== settingsPanelSeq) return;
        const paused = isSiteDisabled(disabledSites, location.href);
        const autoOn = autoSites === null || isSiteDisabled(autoSites, location.href);
        const alwaysOn = isAlwaysSite(alwaysSites, location.href);
        const neverOn = isNeverSite(neverSites, location.href);
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
        const panel = createSettingsPanel({
          languages: LANGUAGES.map((l) => l.name),
          providers: PROVIDERS.map((p) => ({ id: p.id, name: p.name, needsKey: p.needsKey })),
          // 第 10 轮：引擎下拉「未配 Key」标注的依据——免 Key 引擎恒 true。
          hasProviderKey: (providerId) =>
            !PROVIDERS.find((p) => p.id === providerId)?.needsKey ||
            !!getProviderApiKey(cfg, providerId).trim(),
          targetLang: cfg.targetLang,
          translateMode: cfg.translateMode === 'manual' ? 'manual' : 'auto',
          provider: cfg.provider,
          sitePaused: paused,
          siteHost: location.host,
          autoTranslate: autoOn,
          siteAlways: alwaysOn,
          siteNever: neverOn,
          hoverTranslate: hoverOn,
          inputTranslate: inputOn,
          onAutoToggle: (enabled) => {
            enqueueSettingsWrite(async () => {
              const sites = await autoSitesItem.getValue();
              await autoSitesItem.setValue(withSiteDisabled(sites, location.href, enabled));
            });
          },
          onAlwaysToggle: (enabled) => {
            enqueueSettingsWrite(async () => {
              const sites = await alwaysSitesItem.getValue();
              await alwaysSitesItem.setValue(withAlwaysSite(sites, location.href, enabled));
              // 白名单变化立即影响本站自动翻译判定
              refreshSiteRules();
            });
          },
          onNeverToggle: (enabled) => {
            enqueueSettingsWrite(async () => {
              const sites = await neverSitesItem.getValue();
              await neverSitesItem.setValue(withNeverSite(sites, location.href, enabled));
              refreshSiteRules();
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
          onTranslateMode: (value) => {
            enqueueSettingsWrite(async () => {
              const current = normalizeConfig(await configItem.getValue());
              await configItem.setValue({ ...current, translateMode: value });
            });
          },
          onProvider: (value) => {
            enqueueSettingsWrite(async () => {
              const provider = PROVIDERS.find((p) => p.id === value);
              if (!provider) return;
               const current = normalizeConfig(await configItem.getValue());
               const nextConfig = value === 'custom'
                 ? { ...current, provider: value }
                 : {
                     ...current,
                     provider: value,
                     baseUrl: provider.baseUrl,
                     model: provider.defaultModel,
                   };
               await configItem.setValue(nextConfig);
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
        // 构建完成后再校验一次代际：期间被关闭/被更新的打开取代则丢弃本次面板。
        if (mySeq !== settingsPanelSeq) {
          panel.host.remove();
          return;
        }
        settingsPanel = panel;
        // 默认定位在齿轮上方（工具栏常驻右下角，放下方会超出视口）；
        // 上方放不下再放下方。注意上方展开必须与工具栏顶边留出间隙：
        // 面板底边压住工具栏会让齿轮收不到点击（开关语义失效）。
        const panelW = panel.host.offsetWidth || 320;
        const panelH = panel.host.offsetHeight || 400;
        if (panelY + panelH > window.innerHeight - 8 && anchorTop - panelH - 12 >= 8) {
          panelY = anchorTop - panelH - 12;
        }
        const maxX = Math.max(8, window.innerWidth - panelW - 8);
        const maxY = Math.max(8, window.innerHeight - panelH - 8);
        panel.host.style.setProperty(
          'left',
          `${Math.min(Math.max(8, panelX), maxX)}px`,
          'important',
        );
        panel.host.style.setProperty(
          'top',
          `${Math.min(Math.max(8, panelY), maxY)}px`,
          'important',
        );
        // 与完整设置面板保持一致的关闭交互：点击面板外或按 Esc 关闭。
        // 工具栏（含齿轮）上的点击不在此处理，交给齿轮自己的开关逻辑。
        // 闭包引用本地 panel：即使期间 settingsPanel 被替换，判定依然准确。
        const onDocPointerDown = (event: PointerEvent) => {
          if (event.composedPath().includes(panel.host)) return;
          if ((event.target as Element | null)?.closest?.('#ot-toolbar')) return;
          if (settingsPanel === panel) closeSettingsPanel();
        };
        const onDocKeyDown = (event: KeyboardEvent) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          if (settingsPanel === panel) closeSettingsPanel();
        };
        document.addEventListener('pointerdown', onDocPointerDown, true);
        document.addEventListener('keydown', onDocKeyDown, true);
        settingsDismiss = () => {
          document.removeEventListener('pointerdown', onDocPointerDown, true);
          document.removeEventListener('keydown', onDocKeyDown, true);
          settingsDismiss = null;
        };
      } catch (e) {
        showStatus('设置面板打开失败：' + (e instanceof Error ? e.message : '未知错误'), true, 4000);
      }
    }

    // ===== 悬停翻译：鼠标悬停段落 500ms 显示译文气泡（可固定） =====
    let hoverBubble: ReturnType<typeof createHoverBubble> | null = null;
    let hoverTimer: ReturnType<typeof setTimeout> | null = null;
    let hoverPinned = false;
    let hoverEl: Element | null = null;
    let hoverRequestId = 0;

    function hideHoverBubble() {
      stopSpeaking();
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
      if (!el.isConnected) return;
      const myRequest = ++hoverRequestId;
      // 未配置 Key：不发起请求（悬停属被动触发，引导只弹一次）。
      if (await guardSetupGate()) return;
      // await 期间指针可能已经移走：此时拆掉当前气泡、强显旧目标的气泡
      // 会与用户的实际位置相悖，直接放弃本次过期请求。
      if (myRequest !== hoverRequestId) return;
      try {
        if (!el.matches(':hover')) return;
      } catch {
        /* :hover 匹配不可用时忽略该检查 */
      }
      if (hoverPinned) return;
      hideHoverBubble();
      hoverEl = el;
      const text = textOfBlock(el);
      if (text.length < 2) return;
      if (el.querySelector(':scope > .ot-translation')) return;
      hoverBubble = createHoverBubble(
        text,
        (pinned) => {
          hoverPinned = pinned;
        },
        {
          getTargetLang: () => currentTargetLang,
          getVoiceName: () => currentTtsVoice,
        },
      );
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
          hoverBubble.setTranslation(r.translation, { localSkipped: r.localSkipped === true });
          // 跳过结果不进会话缓存（见划词路径同款注释）。
          if (!r.localSkipped) sessionTranslations.remember(text, r.translation);
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
        // 有效手动模式（且站点未显式开启自动）不悬停翻译，保持「按需翻译」。
        if (!effectiveAutoMode()) return;
        const target = e.target as Element | null;
        if (!target || !document.body.contains(target)) return;
        // composedPath 穿透 Shadow DOM：鼠标悬停到自有 UI（如悬停气泡内部按钮）
        // 时不得当作网页内容触发翻译（closest 穿不过 shadow root 会漏判）。
        const path = e.composedPath() as EventTarget[];
        if (hoverBubble && path.includes(hoverBubble.host)) return;
        if (
          target.closest(
            UI_SURFACE_SELECTOR,
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
        if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
        if (el === hoverEl) return;
        hoverTimer = setTimeout(() => showHoverBubbleFor(el), 500);
      },
      true,
    );

    let hoverHideTimer: ReturnType<typeof setTimeout> | null = null;
    document.addEventListener(
      'mousemove',
      (e) => {
        if (!hoverEl || hoverPinned || !hoverBubble) return;
        // 用 composedPath 判断是否落在气泡（或其 Shadow DOM 内部按钮）上：
        // closest('#ot-hover-bubble') 无法穿透 shadow root，会导致鼠标移向
        // 「固定/复制/朗读」按钮时气泡误隐藏、用户来不及点击。
        const path = e.composedPath() as EventTarget[];
        const onBubble = path.includes(hoverBubble.host);
        const target = e.target as Element | null;
        if (onBubble || (target && hoverEl.contains(target))) {
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
        const path = e.composedPath() as EventTarget[];
        // 同上：closest 穿不过 shadow root，点击气泡内部的「固定」会错误地
        // 取消固定并隐藏气泡；用 composedPath 判断是否命中气泡 host。
        if (hoverBubble && path.includes(hoverBubble.host)) return;
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

    // Esc 关闭「固定」的悬停气泡：与其他浮层的 Esc 语义一致。
    // 仅拦固定态且不 stopPropagation：未固定气泡会随鼠标移开自然消失，
    // 若在此吞掉 Esc 会破坏宿主页面自己的快捷键。
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !hoverBubble || !hoverPinned) return;
      hoverPinned = false;
      hideHoverBubble();
    });

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
      stopSpeaking();
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
          // 本地跳过提示：输入框内容已是目标语言时明确说明，而非静默显示原文。
          if (res.localSkipped === true) {
            const hint = document.createElement('div');
            hint.textContent = '原文已是目标语言，未翻译';
            const hintTheme = themeColors();
            Object.assign(hint.style, {
              marginTop: '6px',
              color: hintTheme.muted,
              fontSize: '11px',
              fontFamily: 'inherit',
            });
            host.appendChild(hint);
          } else {
            void addHistoryEntry({ text, translation: res.translation, source: 'input' });
          }
          const copy = document.createElement('button');
          copy.type = 'button';
          copy.textContent = '复制译文';
          // 强调色与圆角取自玻璃主题：深色模式下 #007aff 会偏暗，主题会自动切到 #0a84ff。
          const copyTheme = themeColors();
          Object.assign(copy.style, {
            display: 'block',
            marginTop: '8px',
            padding: '4px 10px',
            border: '0',
            borderRadius: copyTheme.radiusSm,
            background: copyTheme.accentSoft,
            color: copyTheme.accent,
            fontSize: '12px',
            fontWeight: '600',
            cursor: 'pointer',
            fontFamily: 'inherit',
          });
          copy.addEventListener('click', async () => {
            try {
              await navigator.clipboard.writeText(res.translation);
              copy.textContent = '已复制';
              setTimeout(() => { if (copy.isConnected) copy.textContent = '复制译文'; }, 1200);
            } catch {
              copy.textContent = '复制失败';
            }
          });
          const speakBtn = createSpeakButton(() => res.translation, () => currentTargetLang, { getVoiceName: () => currentTtsVoice });
          Object.assign(speakBtn.style, {
            display: 'block',
            marginTop: '8px',
            padding: '4px 10px',
            border: '0',
            borderRadius: '8px',
            background: 'rgba(120,120,128,0.16)',
            color: resultDark ? '#f5f5f7' : '#1d1d1f',
            fontSize: '12px',
            fontWeight: '600',
            cursor: 'pointer',
            fontFamily: 'inherit',
          });
          host.appendChild(speakBtn);
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

      // 玻璃材质统一取自 content-ui 的主题：工具栏与气泡/面板/通知同一套语言。
      const glass = themeColors();
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
        background: glass.surface,
        backdropFilter: glass.backdrop,
        WebkitBackdropFilter: glass.backdrop,
        boxShadow: `${glass.highlight}, ${glass.shadow}`,
        border: `0.5px solid ${glass.border}`,
        cursor: 'grab',
        userSelect: 'none',
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif',
        transition: 'box-shadow 0.2s ease',
      });

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'ot-translate-btn';
      btn.textContent = '\u8BD1'; // "译"
      btn.title = toolbarIdleTitle();
      btn.setAttribute('aria-label', toolbarIdleLabel());
      Object.assign(btn.style, {
        width: '40px',
        height: '40px',
        borderRadius: '50%',
        border: 'none',
        padding: '0',
        background: 'linear-gradient(180deg, #2b8cff 0%, #007aff 100%)',
        backdropFilter: glass.backdrop,
        WebkitBackdropFilter: glass.backdrop,
        color: '#fff',
        fontWeight: '600',
        fontSize: '16px',
        lineHeight: '1',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        boxShadow: '0 3px 10px rgba(0,122,255,0.35)',
        transition: 'transform 0.15s ease, background 0.2s ease, box-shadow 0.2s ease, filter 0.2s ease',
        fontFamily: 'inherit',
      });
      // 主按钮的悬浮反馈：此前只有齿轮与显隐按钮有 hover，主操作反而没有视觉反馈。
      // hover 提亮 + 轻微上浮，active 按压下沉，明确「这是可点的主操作」。
      btn.addEventListener('mouseenter', () => {
        btn.style.background = 'linear-gradient(180deg, #3d99ff 0%, #1284ff 100%)';
        btn.style.boxShadow = '0 4px 14px rgba(0,122,255,0.45)';
        btn.style.transform = 'translateY(-1px)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = 'linear-gradient(180deg, #2b8cff 0%, #007aff 100%)';
        btn.style.boxShadow = '0 3px 10px rgba(0,122,255,0.35)';
        btn.style.transform = 'translateY(0)';
      });
      btn.addEventListener('pointerdown', () => {
        btn.style.transform = 'scale(0.94)';
        btn.style.filter = 'brightness(0.94)';
      });
      btn.addEventListener('pointerup', () => {
        btn.style.transform = 'translateY(0) scale(1)';
        btn.style.filter = '';
      });

      const gear = document.createElement('button');
      gear.type = 'button';
      gear.id = 'ot-settings-btn';
      gear.textContent = '\u2699\uFE0E'; // ⚙（文本变体，避免 emoji 渲染）
      // 第 16 轮：入口文案与面板标题统一为「设置」（不再叫「快速设置」）
      gear.title = '设置';
      gear.setAttribute('aria-label', '打开设置');
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
      // 深浅色由 glass 主题统一决定；齿轮默认色也随主题（不再写死灰色）。
      gear.style.color = glass.text2;
      gear.addEventListener('mouseenter', () => {
        gear.style.background = glass.accentSoft;
        gear.style.color = glass.text;
      });
      gear.addEventListener('mouseleave', () => {
        gear.style.background = 'transparent';
        gear.style.color = glass.text2;
      });

      // 译文显隐按钮：一键在「看原文 / 看译文」之间切换，纯 CSS 不重译（0 Token）。
      const hideBtn = document.createElement('button');
      hideBtn.type = 'button';
      hideBtn.id = 'ot-hide-btn';
      hideBtn.textContent = '\u{1F441}\uFE0E'; // 👁（文本变体，避免 emoji 渲染）
      hideBtn.title = '隐藏译文（快捷键 Alt+S）';
      hideBtn.setAttribute('aria-label', hideBtn.title);
      hideBtn.setAttribute('aria-pressed', 'false');
      Object.assign(hideBtn.style, {
        width: '36px',
        height: '36px',
        borderRadius: '50%',
        border: 'none',
        padding: '0',
        background: 'transparent',
        color: glass.text2,
        fontSize: '15px',
        lineHeight: '1',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        transition: 'background 0.15s ease, color 0.15s ease, opacity 0.15s ease',
        fontFamily: 'inherit',
      });
      hideBtn.addEventListener('mouseenter', () => {
        hideBtn.style.background = glass.accentSoft;
        hideBtn.style.color = glass.text;
      });
      hideBtn.addEventListener('mouseleave', () => {
        hideBtn.style.background = 'transparent';
        hideBtn.style.color = glass.text2;
      });
      hideBtn.addEventListener('click', () => {
        if (typeof wasDrag === 'function' && wasDrag()) return;
        toggleTranslations();
      });

      // 布局：辅助按钮分居两侧，「译」主按钮居中且略大——用户随手点工具条中央
      // 命中的仍是主操作（翻译），具体功能点两侧小按钮，主次分明。
      btn.style.width = '42px';
      btn.style.height = '42px';
      bar.append(hideBtn, btn, gear);
      try {
        document.documentElement.appendChild(bar);
      } catch {
        (document.body || document.documentElement).appendChild(bar);
      }
      // 挂载后按当前模式初始化空闲态文案；并回读一次配置，消除
      // 「工具栏先于配置读取挂载」时用默认模式渲染标签的竞态。
      refreshToolbarIdleLabels();
      void Promise.all([
        configItem.getValue().catch(() => null),
        autoSitesItem.getValue().catch(() => null),
      ]).then(([v, sites]) => {
        if (v) {
          if (v.translateMode === 'auto' || v.translateMode === 'manual') {
            currentTranslateMode = v.translateMode;
          }
        }
        thisSiteAutoOverride =
          Array.isArray(sites) && isSiteDisabled(sites, location.href);
        refreshToolbarIdleLabels();
      });

      // 整条工具条可拖动；位移超过阈值视为拖拽，不触发按钮点击。
      const draggable = makeDraggable(bar, bar, (x, y) => {
        void toolbarPosItem.setValue({ x, y }).catch(() => {});
      });
      const wasDrag = () => draggable.suppressNextClick();

      // 恢复上次拖拽位置。异步回调可能晚于工具栏重建（SPA 自愈）：
      // 应用到「当下」的 #ot-toolbar，而不是闭包里捕获的旧节点。
      void toolbarPosItem
        .getValue()
        .then((pos) => {
          if (!pos) return;
          const current = document.getElementById('ot-toolbar');
          if (!current) return;
          current.style.right = 'auto';
          current.style.bottom = 'auto';
          current.style.left = `${Math.min(Math.max(0, pos.x), Math.max(0, window.innerWidth - current.offsetWidth))}px`;
          current.style.top = `${Math.min(Math.max(0, pos.y), Math.max(0, window.innerHeight - current.offsetHeight))}px`;
        })
        .catch(() => {});

      // 点击委托在整条工具条上：点击容器任意位置（齿轮除外）都触发翻译，
      // 拖拽位移超过阈值时 suppressNextClick 忽略本次点击。
      bar.addEventListener('click', (event) => {
        if (wasDrag()) return;
        // 齿轮与「译文显隐」按钮是独立功能，不能被容器的「点任意处翻译」吞掉。
        if ((event.target as Element | null)?.closest?.('#ot-settings-btn, #ot-hide-btn')) return;
        if (busy) {
          // 取消当前任务并复位交互状态，让下一次点击能立即开始新任务
          // （「翻译中再点 = 取消，再点 = 重译」的既有语义）。
          // pageCancelSeq 让被取消任务在任意 await 恢复点自行退出，
          // 不会与这里手工复位的 busy 竞态出僵尸启动序列。
          pageCancelSeq = pageRunSeq;
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
        // 开关语义：面板已打开时点齿轮 = 关闭（此前只能点 × 关闭）。
        if (settingsPanel) {
          closeSettingsPanel();
          return;
        }
        const rect = gear.getBoundingClientRect();
        void openSettingsPanel(rect.left, rect.bottom + 8, rect.top);
      });
    }

    // 工具栏空闲态文案随「翻译模式」与「页面是否已有译文」变化：
    //   无译文 → 翻译本页；已有译文 → 收起全部译文（再点可重新翻译）。
    // 手动模式下额外标注交互方式，避免点了「译」只看到一行状态而困惑。
    function toolbarIdleLabel(): string {
      if (translatedCount > 0) return '收起全部译文';
      return !effectiveAutoMode()
        ? '翻译当前网页（手动模式：点击段落或划选文字即可翻译）'
        : '翻译当前网页';
    }

    function toolbarIdleTitle(): string {
      if (translatedCount > 0) return '好翻 · 收起全部译文（再次点击重新翻译）';
      return effectiveAutoMode() ? '好翻 · 翻译本页' : '好翻 · 手动模式（点击段落或划词翻译）';
    }

    function refreshToolbarIdleLabels() {
      if (busy) return;
      const bar = document.getElementById('ot-toolbar');
      bar?.setAttribute('aria-label', toolbarIdleLabel());
      const btn = document.getElementById('ot-translate-btn');
      if (btn && btn.getAttribute('aria-busy') !== 'true') {
        btn.setAttribute('aria-label', toolbarIdleLabel());
        btn.title = toolbarIdleTitle();
      }
    }

    function setToolbarLoading(loading: boolean) {
      // 加载底色随主题（深浅色自适应），见 loading 分支。
      const glassForLoading = themeColors();
      const bar = document.getElementById('ot-toolbar');
      const btn = document.getElementById('ot-translate-btn');
      if (bar) {
        if (loading) {
          bar.setAttribute('aria-busy', 'true');
          bar.setAttribute('aria-label', '取消当前翻译');
        } else {
          bar.setAttribute('aria-busy', 'false');
          bar.setAttribute('aria-label', toolbarIdleLabel());
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
        // 加载底色随主题：此前写死 #8fb8ef 与玻璃主题割裂（深色模式下刺眼）。
        // 用主题 accent 的低饱和变体，深浅色都协调，且与「取消」语义匹配。
        btn.style.setProperty('background', glassForLoading.accent, 'important');
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
        btn.setAttribute('aria-label', toolbarIdleLabel());
        // 注意：不能 removeProperty——inline 样式里的原始 width 也会被一并删除，
        // 导致按钮缩回内容宽度（约 25px），工具条整体变窄（历史隐藏 bug）。
        btn.style.setProperty('width', '40px', 'important');
        btn.style.setProperty('padding', '0', 'important');
        btn.style.setProperty('border-radius', '50%', 'important');
        btn.style.setProperty('font-size', '16px', 'important');
        btn.style.setProperty('background', 'linear-gradient(180deg, #2b8cff 0%, #007aff 100%)', 'important');
        btn.style.cursor = 'pointer';
        btn.textContent = '译';
        btn.title = toolbarIdleTitle();
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
