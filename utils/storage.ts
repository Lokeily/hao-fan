import { storage } from 'wxt/utils/storage';
import { DEFAULT_CONFIG, type AppConfig } from './config.ts';
import { EMPTY_USAGE_TOTALS, type MonthUsage, type UsageTotals } from './usage.ts';

// 全局配置。API Key 仅持久化在 storage.local，并只随翻译请求发送给所选服务商。
export const configItem = storage.defineItem<AppConfig>('local:config', {
  defaultValue: DEFAULT_CONFIG,
});

export const usageItem = storage.defineItem<UsageTotals>('local:usageStats', {
  defaultValue: EMPTY_USAGE_TOTALS,
});

// 月度 Token 预算用量（按自然月累计，跨月自动归零；供 popup 预算进度与告警展示）。
export const monthUsageItem = storage.defineItem<MonthUsage | null>('local:monthUsage', {
  defaultValue: null,
});

// 与模型配置分开保存，避免修改 API / 语言偏好时覆盖用户的站点暂停列表。
export const disabledSitesItem = storage.defineItem<string[]>('local:disabledSites', {
  defaultValue: [],
});

// 自动翻译站点列表（每站记忆"总是自动翻译"偏好，与暂停列表独立）。
// defaultValue 为 null 表示"用户尚未配置"→ 按默认全开处理（默认自动翻译此站）。
export const autoSitesItem = storage.defineItem<string[] | null>('local:autoSites', {
  defaultValue: null,
});

// ===== 0.2.2 网站规则增强：始终翻译白名单 / 敏感页面排除 =====
// 与 disabledSitesItem / autoSitesItem 并存：三者分别表达
// 暂停（黑名单） / 总是自动（白名单自动翻译） / 敏感页面从不翻译（URL 子串）。
// 分开存储避免互相覆盖，读取时合并判定（见 utils/site-policy.ts）。
export const alwaysSitesItem = storage.defineItem<string[]>('local:alwaysSites', {
  defaultValue: [],
});

export const neverSitesItem = storage.defineItem<string[]>('local:neverSites', {
  defaultValue: [],
});

// 首次使用引导：还没填 API Key 时提示一次「去设置」，提示过就不再打扰。
// 用户后来清空 Key 也不会二次弹窗——工具栏与设置面板里始终能重新进入设置。
export const setupNoticeShownItem = storage.defineItem<boolean>('local:setupNoticeShown', {
  defaultValue: false,
});

// 首启引导（onboarding）是否已完成：从未配置过任何 Key 的新用户，
// 首次打开弹窗会看到欢迎面板（免费体验 / 配置 AI 引擎二选一），
// 完成选择后置位，不再打扰。与 setupNoticeShownItem 不同：后者只是「去设置」提示，
// 前者是真正的分步引导，面向完全没接触过 API Key 概念的普通用户。
export const onboardingDoneItem = storage.defineItem<boolean>('local:onboardingDone', {
  defaultValue: false,
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
// B2 气泡位置记忆：用户拖到哪就记住哪，下次打开气泡停在原位置。
export const hoverBubblePosItem = storage.defineItem<{ x: number; y: number } | null>(
  'local:hoverBubblePos',
  { defaultValue: null },
);

// ===== 一次性迁移：v0.2.0 起翻译模式默认改为「手动」=====
// 老版本保存的全量快照里带着 translateMode:'auto'，仅修改 DEFAULT_CONFIG
// 对已有用户不生效；此迁移保证升级后同样切换为手动（可在设置中改回自动）。
const manualDefaultAppliedItem = storage.defineItem<boolean>('local:v2ManualDefaultApplied', {
  defaultValue: false,
});

export async function applyManualDefaultMigration(): Promise<void> {
  try {
    if (await manualDefaultAppliedItem.getValue()) return;
    const cfg = await configItem.getValue();
    await configItem.setValue({ ...cfg, translateMode: 'manual' });
    await manualDefaultAppliedItem.setValue(true);
  } catch {
    /* 存储不可用时跳过迁移，下次启动重试 */
  }
}
