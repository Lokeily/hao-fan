import { storage } from 'wxt/utils/storage';
import { DEFAULT_CONFIG, type AppConfig } from './config.ts';
import { EMPTY_USAGE_TOTALS, type UsageTotals } from './usage.ts';

// 全局配置。API Key 仅持久化在 storage.local，并只随翻译请求发送给所选服务商。
export const configItem = storage.defineItem<AppConfig>('local:config', {
  defaultValue: DEFAULT_CONFIG,
});

export const usageItem = storage.defineItem<UsageTotals>('local:usageStats', {
  defaultValue: EMPTY_USAGE_TOTALS,
});

// 与模型配置分开保存，避免修改 API / 语言偏好时覆盖用户的站点暂停列表。
export const disabledSitesItem = storage.defineItem<string[]>('local:disabledSites', {
  defaultValue: [],
});

// 悬浮工具栏的拖拽位置（右下角像素偏移），null 表示使用默认右下角。
export const toolbarPosItem = storage.defineItem<{ right: number; bottom: number } | null>(
  'local:toolbarPos',
  { defaultValue: null },
);
