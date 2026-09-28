import { PROVIDERS } from './providers.ts';

export interface AppConfig {
  provider: string;
  baseUrl: string;
  apiKeys: Record<string, string>;
  model: string;
  sourceLang: string;
  targetLang: string;
  systemPrompt: string;
  cacheEnabled: boolean;
  tone: string;
  glossaryEnabled: boolean;
  customGlossary: string;
  customVision: boolean;
  // ===== 0.1.5 新增能力开关与路由 =====
  streaming: boolean; // SSE 流式输出（首块首字 <1s）
  contextAware: boolean; // 上下文感知翻译（标题 + 前段译文滑动窗口）
  qualityCheck: boolean; // 翻译质量自检（数字/URL/代码 token 保真）
  autoLearnTerms: boolean; // 译文可编辑 → 术语自动学习
  sentenceCache: boolean; // 句子级缓存 + 归一化匹配（省 Token）
  glossaryTermLimit: number; // 术语注入条数上限（0 关闭，默认 12，越低越省 Token）
  hoverTranslate: boolean; // 鼠标悬停翻译（hover 段落即译）
  inputTranslate: boolean; // 网页输入框翻译（聚焦时提供翻译按钮）
  translationStyle: string; // 译文显示样式：plain / dashed / underline / highlight
  // ===== 0.2.2 译文排版自定义（基础四项）=====
  translationFontSize: number; // 译文字号（px，0 = 跟随原文）
  translationLineHeight: number; // 译文行高（0 = 跟随原文 1.5）
  translationOpacity: number; // 译文透明度（0.3~1，0 = 默认 0.82/0.9）
  translationColor: string; // 译文文字颜色（空 = 跟随原文）
  // ===== 0.2.2 对照模式 =====
  dualMode: 'below' | 'translation-only' | 'hover-original'; // 对照方式
  // ===== 0.2.2 网站规则：始终翻译 / 敏感页面排除 =====
  alwaysTranslateSites: string[]; // 白名单：始终翻译的域名（即使全局手动模式）
  neverTranslateSites: string[]; // 敏感/黑名单：从不翻译的 URL 子串或域名
  themeMode: 'auto' | 'light' | 'dark'; // 界面主题：跟随系统 / 强制浅色 / 强制深色
  ttsVoiceName: string; // 朗读人声：浏览器语音名（空 = 自动选择该语言最佳人声）
  translateMode: 'auto' | 'manual'; // 翻译模式：manual=仅划词/点击翻译（默认）；auto=整页自动
  fallbackProviders: string[]; // 多引擎故障转移：主引擎 429/5xx 时按顺序切换
  strongProvider: string; // 长文强模型路由：超过阈值改用此服务商
  strongModel: string; // 长文强模型路由：目标模型
  strongThreshold: number; // 长文路由字符阈值
  monthlyTokenBudget: number; // 月度 Token 预算（0 = 不限）。BYOK 用户自付 API 费，超预算即警告
  budgetWarnPercent: number; // 预算告警阈值百分比（默认 80：用到 80% 时提醒）
}

export type StoredAppConfig = Partial<AppConfig> & { apiKey?: string };

const RETIRED_BASE_URLS: Record<string, Record<string, string>> = {
  zhipu: {
    'https://open.bigmodel.cn/api/ai/v1': 'https://open.bigmodel.cn/api/paas/v4',
  },
};

export const DEFAULT_CONFIG: AppConfig = {
  // 默认引擎 = MyMemory（免 Key）：新用户装完即用，无需任何注册/填 Key。
  // 实测可用的免 Key 公共通道里，只有 MyMemory 稳定支持中英且为正规开放 API；
  // Google 的 client=gtx 端点在国内网络不可达、微软 Edge 免 Key 端点已下线，均已移除。
  // 想更准更快时，在设置页改引擎并填入自己的 API Key 即可（BYOK）。
  provider: 'mymemory',
  baseUrl: 'https://api.mymemory.translated.net',
  apiKeys: {},
  model: '',
  sourceLang: '自动检测',
  targetLang: '中文',
  systemPrompt: '',
  cacheEnabled: true,
  tone: '自然流畅',
  glossaryEnabled: true,
  customGlossary: '',
  customVision: false,
  streaming: true,
  contextAware: true,
  qualityCheck: true,
  autoLearnTerms: true,
  sentenceCache: true,
  glossaryTermLimit: 12,
  hoverTranslate: true,
  inputTranslate: true,
  translationStyle: 'plain',
  translationFontSize: 0,
  translationLineHeight: 0,
  translationOpacity: 0,
  translationColor: '',
  dualMode: 'below',
  alwaysTranslateSites: [],
  neverTranslateSites: [],
  themeMode: 'auto',
  ttsVoiceName: '',
  translateMode: 'manual',
  // 免 Key 通道没有 SLA：主通道额度用完/超时就自动降级到下一个免 Key 通道，
  // 保证「装完就能用」，而不是把失败抛给还什么都没配的用户。
  fallbackProviders: ['apertium'],
  strongProvider: '',
  strongModel: '',
  strongThreshold: 1200,
  monthlyTokenBudget: 0,
  budgetWarnPercent: 80,
};

export function normalizeConfig(stored?: StoredAppConfig | null): AppConfig {
  const { apiKey: legacyApiKey, dualMode: _legacyDualMode, ...values } = stored ?? {};
  let provider = values.provider || DEFAULT_CONFIG.provider;
  const apiKeys = { ...(values.apiKeys || {}) };
  const storedBaseUrl = values.baseUrl?.replace(/\/+$/, '');
  let baseUrl = (storedBaseUrl && RETIRED_BASE_URLS[provider]?.[storedBaseUrl]) || values.baseUrl;
  const migratedFromGoogle = provider === 'google' && !apiKeys.google;

  // 0.1.x 只保存一个 Key；首次读取时归入当时选中的服务商。
  if (legacyApiKey && !apiKeys[provider]) apiKeys[provider] = legacyApiKey;

  // Google 免 Key 通道已下线（端点在国内不可达 + 无 SLA）：把「从未手动配过 Key」
  // 的 google 配置迁到 MyMemory，否则老用户更新后还是翻译不了。
  // 手动给 Google 配过真 Key 的用户不受影响（他们走的是付费路径）。
  if (migratedFromGoogle) {
    provider = DEFAULT_CONFIG.provider;
    if (!baseUrl || /translate\.googleapis\.com|translate\.google\.com/.test(baseUrl)) {
      baseUrl = DEFAULT_CONFIG.baseUrl;
    }
  }

  // 0.2.2 dualMode 由旧 boolean 死字段升级为字符串三态：解构时已被取出，
  // 这里直接对解构值做三态判定；历史 boolean（false/true）归一化为默认 'below'。
  const rawDualMode = _legacyDualMode;
  const dualMode =
    rawDualMode === 'below' || rawDualMode === 'translation-only' || rawDualMode === 'hover-original'
      ? rawDualMode
      : DEFAULT_CONFIG.dualMode;

  // 引擎与端点必须成对：非 custom 引擎的端点在 UI 里是只读的（随引擎自动切换），
  // 存储里两者不匹配（历史残留/并发写入）必然产生「DeepSeek + MyMemory 端点」
  // 这类组合——请求打到错误的服务商上必失败。加载时校正回该引擎的预设端点。
  if (provider !== 'custom') {
    const preset = PROVIDERS.find((p) => p.id === provider);
    if (preset?.baseUrl && baseUrl && baseUrl !== preset.baseUrl) baseUrl = preset.baseUrl;
    if (preset?.baseUrl && !baseUrl) baseUrl = preset.baseUrl;
  }

  return {
    ...DEFAULT_CONFIG,
    ...values,
    // dualMode 显式覆盖：…values 展开可能带入旧 boolean 脏值或非法字符串
    dualMode,
    provider,
    ...(baseUrl ? { baseUrl } : {}),
    apiKeys,
  };
}

export function getProviderApiKey(cfg: AppConfig, provider = cfg.provider): string {
  return cfg.apiKeys[provider] || '';
}

export function withProviderApiKey(
  cfg: AppConfig,
  apiKey: string,
  provider = cfg.provider,
): AppConfig {
  const apiKeys = { ...cfg.apiKeys };
  const trimmed = apiKey.trim();
  if (trimmed) apiKeys[provider] = trimmed;
  else delete apiKeys[provider];
  return { ...cfg, apiKeys };
}
