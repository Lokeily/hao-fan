import { storage } from 'wxt/utils/storage';
import { DEFAULT_CONFIG, type AppConfig } from './config';
import { EMPTY_USAGE_TOTALS, type UsageTotals } from './usage';

// 全局配置。API Key 仅持久化在 storage.local，并只随翻译请求发送给所选服务商。
export const configItem = storage.defineItem<AppConfig>('local:config', {
  defaultValue: DEFAULT_CONFIG,
});

export const usageItem = storage.defineItem<UsageTotals>('local:usageStats', {
  defaultValue: EMPTY_USAGE_TOTALS,
});
