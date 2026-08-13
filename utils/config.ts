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
  customVision: false,
};

export function normalizeConfig(stored?: StoredAppConfig | null): AppConfig {
  const { apiKey: legacyApiKey, dualMode: _legacyDualMode, ...values } = stored ?? {};
  const provider = values.provider || DEFAULT_CONFIG.provider;
  const apiKeys = { ...(values.apiKeys || {}) };
  const storedBaseUrl = values.baseUrl?.replace(/\/+$/, '');
  const baseUrl = (storedBaseUrl && RETIRED_BASE_URLS[provider]?.[storedBaseUrl]) || values.baseUrl;

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
