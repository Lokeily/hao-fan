import { DEFAULT_CONFIG, normalizeConfig, type AppConfig } from './config.ts';

// ===== 设置备份文件格式（v1）=====
// app/kind 用于防止把任意 JSON 误导入；config 只接受已知字段且类型匹配。

export const BACKUP_APP = 'hao-fan';
export const BACKUP_KIND = 'settings';
export const BACKUP_VERSION = 1;

export interface SettingsBackup {
  app: typeof BACKUP_APP;
  kind: typeof BACKUP_KIND;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  config: Partial<AppConfig>;
  disabledSites?: string[];
  autoSites?: string[] | null;
}

// 把导入的任意对象收敛成安全的 AppConfig：只拷贝已知字段且类型必须与默认值一致，
// 拒绝脏数据进入 storage（导入文件可能来自任何地方）。
export function sanitizeImportedConfig(raw: unknown): AppConfig {
  const out = { ...DEFAULT_CONFIG, apiKeys: {} } as unknown as Record<string, unknown>;
  if (raw && typeof raw === 'object') {
    const source = raw as Record<string, unknown>;
    for (const [key, fallback] of Object.entries(DEFAULT_CONFIG)) {
      const value = source[key];
      if (typeof fallback === 'boolean') {
        if (typeof value === 'boolean') out[key] = value;
      } else if (typeof fallback === 'number') {
        if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
      } else if (Array.isArray(fallback)) {
        if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
          out[key] = value;
        }
      } else if (key === 'apiKeys') {
        if (value && typeof value === 'object') {
          const keys: Record<string, string> = {};
          for (const [provider, secret] of Object.entries(value as Record<string, unknown>)) {
            if (typeof provider === 'string' && typeof secret === 'string') keys[provider] = secret;
          }
          out.apiKeys = keys;
        }
      } else if (typeof fallback === 'string') {
        if (typeof value === 'string') out[key] = value;
      }
    }
  }
  const result = out as unknown as AppConfig;
  // 枚举收敛：非法值回落到默认「手动」；themeMode 同理回落「跟随系统」
  if (result.translateMode !== 'manual' && result.translateMode !== 'auto') {
    result.translateMode = 'manual';
  }
  if (result.themeMode !== 'light' && result.themeMode !== 'dark') result.themeMode = 'auto';
  if (result.imageRenderMode !== 'bilingual') result.imageRenderMode = 'translation';
  return normalizeConfig(result);
}

export function isSettingsBackup(data: unknown): data is SettingsBackup {
  if (!data || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  if (record.app !== BACKUP_APP || record.kind !== BACKUP_KIND) return false;
  if (record.version !== BACKUP_VERSION) return false;
  // config 必须是对象：畸形备份（如手工编辑出错）不得静默重置全部设置
  if (!record.config || typeof record.config !== 'object' || Array.isArray(record.config)) return false;
  if (
    record.disabledSites !== undefined &&
    (!Array.isArray(record.disabledSites) ||
      !record.disabledSites.every((s) => typeof s === 'string'))
  )
    return false;
  if (
    record.autoSites !== undefined &&
    record.autoSites !== null &&
    (!Array.isArray(record.autoSites) || !record.autoSites.every((s) => typeof s === 'string'))
  )
    return false;
  return true;
}

export function parseBackup(text: string): SettingsBackup | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  return isSettingsBackup(data) ? data : null;
}

/** 构建剪贴板快速迁移用的 JSON 文本（含 Key，由调用方决定是否剥离）。 */
export function buildClipboardPayload(config: AppConfig): string {
  return JSON.stringify(
    {
      app: BACKUP_APP,
      kind: BACKUP_KIND,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      config,
    },
    null,
    2,
  );
}
