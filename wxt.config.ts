import { defineConfig } from 'wxt';
import { runPostbuild } from './scripts/postbuild';

// 参考文档: https://wxt.dev
export default defineConfig({
  // 构建完成后统一处理页面资源（内联 CSS + 相对路径），wxt build 与 wxt zip 均会触发。
  hooks: {
    'build:done': async () => {
      await runPostbuild();
    },
  },
  manifest: ({ browser }) => ({
    name: '好翻',
    description:
      '好翻 · 开源免费的沉浸式 AI 翻译插件，直连 DeepSeek、智谱、腾讯混元等国内大模型，用户自配 API Key，不经中转服务器。',
    // WXT 根据 entrypoints/options.html 与 popup.html 生成 options_ui / action.default_popup
    permissions: ['storage', 'activeTab', 'contextMenus', 'scripting'],
    // 快捷键：Alt+T 翻译当前网页（浏览器设置页可自定义）
    commands: {
      'translate-page': {
        suggested_key: { default: 'Alt+T' },
        description: '翻译当前网页（好翻）',
      },
    },
    // 后台需要跨域调用各家大模型 API，故放开 host 权限
    host_permissions: ['<all_urls>'],
    browser_specific_settings:
      browser === 'firefox'
        ? {
            gecko: {
              id: 'open-translator-cn@haofan',
              data_collection_permissions: {
                // 翻译请求会把用户配置的 API Key 和待翻译网页内容发送给所选服务商。
                required: ['authenticationInfo', 'websiteContent'],
              },
            },
          }
        : undefined,
    // 显式收紧内容安全策略：禁止页面内联脚本/远程脚本，仅允许扩展自身资源（P2-4）
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self';",
    },
  }),
});
