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
  // ===== 多引擎路由 =====
  // 备用引擎：主引擎（密钥 / 端点 / 模型）不可用时自动故障转移。
  fallbackEnabled: boolean;
  fallbackProvider: string;
  fallbackApiKey: string;
  fallbackBaseUrl: string;
  fallbackModel: string;
  // 长文强模型：单段超过阈值时改用更强（通常更贵）的模型路由，保证长段落质量。
  longTextModel: string;
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
  fallbackEnabled: false,
  fallbackProvider: '',
  fallbackApiKey: '',
  fallbackBaseUrl: '',
  fallbackModel: '',
  longTextModel: '',
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
