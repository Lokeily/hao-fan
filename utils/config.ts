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
  // 术语注入上限：单批翻译注入提示词的术语条数上限（节省 Token 的核心之一，可调节）。
  glossaryInjectionLimit: number;
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
  fallbackProviders: string[]; // 多引擎故障转移：主引擎 429/5xx 时按顺序切换
  strongProvider: string; // 长文强模型路由：超过阈值改用此服务商
  strongModel: string; // 长文强模型路由：目标模型
  strongThreshold: number; // 长文路由字符阈值
}

export type StoredAppConfig = Partial<AppConfig> & { apiKey?: string; dualMode?: boolean };

const RETIRED_BASE_URLS: Record<string, Record<string, string>> = {
  zhipu: {
    'https://open.bigmodel.cn/api/ai/v1': 'https://open.bigmodel.cn/api/paas/v4',
  },
};

export const DEFAULT_CONFIG: AppConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  apiKeys: {},
  model: 'deepseek-chat',
  sourceLang: '自动检测',
  targetLang: '中文',
  systemPrompt: '',
  cacheEnabled: true,
  tone: '自然流畅',
  glossaryEnabled: true,
  customGlossary: '',
  glossaryInjectionLimit: 24,
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
  fallbackProviders: [],
  strongProvider: '',
  strongModel: '',
  strongThreshold: 1200,
};

export function normalizeConfig(stored?: StoredAppConfig | null): AppConfig {
  const { apiKey: legacyApiKey, dualMode: _legacyDualMode, ...values } = stored ?? {};
  const provider = values.provider || DEFAULT_CONFIG.provider;
  const apiKeys = { ...(values.apiKeys || {}) };
  const rawBaseUrl = (values.baseUrl ?? '').trim();
  const storedBaseUrl = rawBaseUrl.replace(/\/+$/, '');
  const migratedBaseUrl = storedBaseUrl && RETIRED_BASE_URLS[provider]?.[storedBaseUrl];
  // 迁移后的地址优先；其次用用户原始填写（保留写法，含尾斜杠）；为空串（未填写 / 被清空）时
  // 回退到默认端点，避免把空串当作有效端点，否则 callChat 会因「未配置 API Base URL」令整页失败。
  const baseUrl = migratedBaseUrl || (rawBaseUrl ? (values.baseUrl ?? '') : DEFAULT_CONFIG.baseUrl);

  // 0.1.x 只保存一个 Key；首次读取时归入当时选中的服务商。
  if (legacyApiKey && !apiKeys[provider]) apiKeys[provider] = legacyApiKey;

  return {
    ...DEFAULT_CONFIG,
    ...values,
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
