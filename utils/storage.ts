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

// 自动翻译站点列表（每站记忆"总是自动翻译"偏好，与暂停列表独立）。
export const autoSitesItem = storage.defineItem<string[]>('local:autoSites', {
  defaultValue: [],
});

// 悬浮工具栏与设置面板的拖拽位置（仅存位置，跟随用户习惯）。
export const toolbarPosItem = storage.defineItem<{ x: number; y: number } | null>(
  'local:toolbarPos',
  { defaultValue: null },
);
export const settingsPanelPosItem = storage.defineItem<{ x: number; y: number } | null>(
  'local:settingsPanelPos',
  { defaultValue: null },
);
