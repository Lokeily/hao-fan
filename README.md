# 好翻 · Open Translator CN

<p align="center">
  <img src="public/icon-128.png" alt="好翻" width="96" height="96">
</p>

<p align="center">
  <strong>开源、免费、可自配 API 的沉浸式双语网页翻译扩展。</strong>
</p>

<p align="center">
  <a href="https://github.com/Lokeily/hao-fan/actions/workflows/build.yml"><img src="https://github.com/Lokeily/hao-fan/actions/workflows/build.yml/badge.svg?branch=main" alt="Build"></a>
  <a href="#安装"><img src="https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white" alt="Chrome"></a>
  <a href="#安装"><img src="https://img.shields.io/badge/Firefox-MV2-FF7139?logo=firefoxbrowser&logoColor=white" alt="Firefox"></a>
  <a href="#安装"><img src="https://img.shields.io/badge/Edge-compatible-0078D7?logo=microsoftedge&logoColor=white" alt="Edge"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"></a>
  <a href="https://github.com/Lokeily/hao-fan/releases/latest"><img src="https://img.shields.io/badge/version-0.1.20-blue" alt="v0.1.20"></a>
</p>

## 简介

「好翻」是一款浏览器翻译扩展：保留网页原文，把译文自然地显示在原文下方，逐段对照阅读。

- 免费开源，无使用额度，无遥测、无广告追踪
- 内置 12+ 家 AI 服务商与 3 家传统机器翻译预设，也支持任意 OpenAI 兼容接口与本地模型
- API Key 只保存在本地，翻译请求直连所选服务商，不经任何中转服务器

## 功能特性

| 功能 | 说明 |
| --- | --- |
| 沉浸式双语对照 | 原文保留，译文显示在原文下方，随页面滚动自然跟随 |
| 流式输出 | 首段边生成边显示，首字延迟低至毫秒级（基线实测 ~90ms） |
| 上下文感知翻译 | 结合页面标题与前段译文，长文代词指代与术语更连贯 |
| 翻译质量自检 | 数字 / URL / 代码 token 保真校验，缺失自动校正并标记提示 |
| 可见区域优先 | 先翻译当前屏幕内容，滚动时继续翻译新内容 |
| 动态内容翻译 | 弹窗、菜单、无限滚动等异步加载的内容自动补译 |
| 划词翻译 | 选中文字即译，独立浮窗展示，不改变原网页 |
| 译文可编辑 · 术语自学习 | hover 译文即可修改，自动抽取术语沉淀进个人术语表 |
| 图片翻译 | 网页图片与本地图片 OCR + 翻译（需支持视觉的模型） |
| 按网站暂停 | 一键暂停当前网站、清理译文，无需刷新即可恢复 |
| 多引擎路由 | 备用引擎故障转移（限流/报错自动切换）+ 长文强模型路由 |
| 节省 Token | 句子级缓存、重复文本合并、术语库命中零请求、目标语言跳过、术语注入上限可调 |
| 可拖动工具栏 | 「译 + 设置」悬浮按钮组可拖到任意位置，位置自动记忆 |
| 页面内快速设置 | 齿轮按钮弹出悬浮设置窗：语言 / 引擎 / 暂停本站即改即生效 |
| 翻译进度显示 | 状态条实时显示已译 X/Y 段，加载态带旋转指示 |
| 键盘快捷键 | Alt+T 直接翻译当前网页（浏览器设置页可自定义） |
| 自定义能力 | 服务商、模型、Base URL、提示词、术语表、翻译风格均可配置 |

## 支持的翻译服务

- **AI 服务**：DeepSeek、OpenAI、Google Gemini、OpenRouter、智谱 GLM、腾讯混元、通义千问、Kimi、百川智能、豆包、Ollama 本地模型、任意 OpenAI 兼容接口
- **传统机器翻译**：Google 翻译（免 Key）、DeepL、Microsoft 翻译

> Google 翻译（免 Key）走的是非官方免费端点，无服务等级保证，偶尔会限流或临时不可用，建议仅用于体验；正式使用请配置支持 API Key 的服务。

## 安装

1. 打开 [Releases](https://github.com/Lokeily/hao-fan/releases/latest)，下载对应浏览器的 ZIP 并解压。
2. **Chrome / Edge**：访问 `chrome://extensions`（Edge 为 `edge://extensions`）→ 开启「开发者模式」→「加载已解压的扩展程序」→ 选择解压后**直接包含 `manifest.json`** 的目录。
3. **Firefox**：访问 `about:debugging#/runtime/this-firefox` →「临时载入附加组件」→ 选择解压目录中的 `manifest.json`。Firefox 未签名扩展在浏览器重启后会消失，属浏览器限制。

## 快速开始

1. 点击工具栏「好翻」图标 → 打开「设置」。
2. 选择服务商，填写 API Key，设置目标语言，点击「测试连接」确认可用。
3. 回到网页，点击右下角蓝色「译」按钮开始翻译；翻译中再次点击可取消。

想先体验？在设置中选择「Google 翻译」即可免 Key 使用。

## 隐私与安全

完整说明见 [PRIVACY.md](./PRIVACY.md)。

- API Key 仅保存在浏览器本地（`storage.local`），按服务商隔离存储，直发所选服务商
- 无遥测、无广告追踪、无用户行为统计；网站暂停列表仅保存在本地
- 翻译请求带注入防护：待译文本被标记为「数据而非指令」，降低恶意网页操纵译文的风险
- 扩展页面启用严格内容安全策略，禁止加载远程脚本
- 本地翻译缓存默认 30 天有效期与容量上限，可在设置中关闭

## 开发

```bash
git clone https://github.com/Lokeily/hao-fan.git
cd hao-fan
npm install
npm run dev   # 开发模式，加载 .output/chrome-mv3-dev
```

质量检查：

```bash
npm test             # 单元测试
npm run typecheck    # 类型检查
npm run build        # 构建
npm run test:browser # 浏览器回归测试
npm run zip          # 打包 Chrome 安装包
```

## 商店上架

上架工作推进中：Chrome Web Store / Edge / Firefox AMO 的提交清单见 [docs/STORE_SUBMISSION.md](./docs/STORE_SUBMISSION.md)。上架后即可获得自动更新，无需手动覆盖安装。

## 参与贡献

欢迎提交 Bug 报告、功能建议与代码。请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)，并遵守 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。安全漏洞请按 [SECURITY.md](./SECURITY.md) 私下联系作者，不要公开到 Issue。

## 许可证

[MIT](./LICENSE)
