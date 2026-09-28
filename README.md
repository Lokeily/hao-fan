<div align="center">

<img src="public/icon-128.png" alt="好翻" width="96" height="96">

# 好翻 · Open Translator CN

**开源、免费、直连自选 AI 的沉浸式双语网页翻译扩展**

*An open-source immersive bilingual web translation extension that talks directly to your own AI provider.*

[![Build](https://github.com/Lokeily/hao-fan/actions/workflows/build.yml/badge.svg?branch=main)](https://github.com/Lokeily/hao-fan/actions/workflows/build.yml)
![Version](https://img.shields.io/badge/version-0.2.8-blue)
![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)
![Firefox MV2](https://img.shields.io/badge/Firefox-MV2-FF7139?logo=firefoxbrowser&logoColor=white)
![Edge](https://img.shields.io/badge/Edge-compatible-0078D7?logo=microsoftedge&logoColor=white)
![Tests](https://img.shields.io/badge/tests-87%20unit%20%2B%2065%20e2e-brightgreen)
![License](https://img.shields.io/badge/license-MIT-green)

[功能特性](#-功能特性) · [快速开始](#-快速开始) · [安装](#-安装) · [配置参考](#-配置参考) · [隐私与安全](#-隐私与安全) · [参与贡献](#-参与贡献)

</div>

---

## 为什么选择好翻

与云端聚合翻译服务不同，好翻**直连你自己配置的翻译服务商**——请求不经过任何中转服务器，API Key 只保存在本机浏览器，不向第三方上传浏览内容。

- **无中心** — 谁给你翻译，由你决定：12 家国内外 AI 服务商 + 任意 OpenAI 兼容接口 + 3 家传统机翻
- **无遥测** — 不采集使用行为，无广告追踪，无使用额度
- **可解释** — 每项行为都能在源码中找到对应实现，透明可审计

## ✨ 功能特性

### 核心翻译

| 功能 | 说明 |
| --- | --- |
| 📖 **沉浸式双语对照** | 原文保留，译文以独立节点渲染在原文下方（Shadow DOM），随页面滚动自然跟随 |
| ⚡ **流式输出** | 划词 / 悬停 / 点段落 / 输入框逐字回填，首字即显；异常自动回退，不漏译 |
| 🧠 **上下文感知** | 结合页面标题与前段译文构造滑动窗口，长文代词指代与术语更连贯 |
| ✅ **翻译质量自检** | 译后校验数字 / URL / 邮箱 / 占位符 / 代码 token 保真度，缺失自动校正重试并标记 |
| 👁 **可见区域优先** | 先译首屏，滚动中按需翻译新进入视口的内容 |
| 🔄 **动态内容翻译** | 弹窗、无限滚动等异步内容自动补译；8 秒冷却 + 数字就地更新防烧 Token |
| ✍️ **划词翻译** | 选中文字即出结果浮层，支持复制与朗读 |
| 🖱 **悬停翻译** | 鼠标悬停段落即出译文气泡（可固定、可关闭） |
| 🎯 **手动模式** | 整页自动与「点击段落 / 划词」手动模式一键切换 |

### v0.2.0 新增

| 功能 | 说明 |
| --- | --- |
| 🔊 **朗读译文** | 划词面板 / 悬停气泡 / 输入框结果均可一键 TTS 朗读，按目标语言自动匹配发音 |
| 🕘 **翻译历史** | 弹窗新增「历史」标签页：搜索、点击回填重译、一键清空，本地存储 200 条 |
| 🗑 **缓存管理** | 设置页实时显示缓存条数，一键清空 |
| 🌗 **主题覆盖** | 跟随系统之外可强制浅色 / 深色，所有界面统一生效 |
| 💾 **设置备份** | 配置导出为 JSON 文件，跨设备迁移；API Key 默认不导出，导入严格校验 |

### v0.2.1 优化

| 功能 | 说明 |
| --- | --- |
| 🧭 **默认手动模式** | 进入网页不再自动整页翻译——点击段落 / 划词即译，掌控权交还用户（可切回自动） |
| 🔤 **中文识别增强** | 两字 UI 词与中英混排句不再被误送翻译，杜绝中译中 |
| 📐 **译文落点回退** | 渲染后几何校验 + 自动降级，多列/浮动/绝对定位场景译文不再漂移 |
| 🗂 **面板分区重排** | 六分区编号导航，Base URL 与测试连接上移、路由设置独立成区 |
| 📋 **剪贴板迁移** | 复制全部设置（含 Key）/ 从剪贴板导入，换装新版本一键带走配置 |

### 省钱与效率

| 机制 | 原理 |
| --- | --- |
| 句子级缓存 | 按句缓存 + 归一化匹配，SPA 微变只重译变化句；缺失句合并为一次批量请求 |
| 多级缓存 | 整段缓存 30 天 LRU（2000 条）；术语库命中零请求；已是目标语言本地跳过零 Token |
| 多引擎路由 | 主引擎限流 / 报错自动切换备用引擎；长文本自动路由到强模型 |
| 标识符保护 | `useState`、`react-dom` 等标识符先占位、译后还原，库名不被翻译且省 completion |
| 译文可编辑 | 悬停译文即可修改，改动经 LLM 抽取自动沉淀进个人术语表并即时生效 |

## 🖼 界面一览

| 沉浸式双语对照 | 划词翻译 + 朗读 | 页内快速设置 |
| :---: | :---: | :---: |
| 译文贴在原文正下方，不破坏排版 | 选中即译，支持复制与 TTS 朗读 | 无需跳转，页内即改即生效 |

> 截图即将补充。欢迎通过 PR 提交你的使用截图。

## 🚀 快速开始

1. 点击工具栏「好翻」图标 → 打开「设置」
2. 选择服务商，填入 API Key，设置目标语言，点「测试连接」确认可用
3. 回到任意英文网页 —— 默认为**手动模式**：点击段落或划选文字即可翻译；也可在设置中切换为「整页自动」。

**想先体验？** 装完即用内置免 Key 通道（MyMemory），零配置直接翻译。
**追求最省 Token？** 把「翻译模式」切到「手动点击 / 划词」——整页不自动翻译，点哪段译哪段。
**还没配 Key？** 好翻不会发送任何无效请求，而是弹出一次性引导卡，填好 Key 后自动继续翻译。

## 📥 安装

### 从 Release 下载（推荐）

前往 [Releases](https://github.com/Lokeily/hao-fan/releases/latest) 下载对应浏览器的 ZIP 并解压：

- **Chrome / Edge**：访问 `chrome://extensions`（Edge 为 `edge://extensions`）→ 开启「开发者模式」→「加载已解压的扩展程序」→ 选择解压后直接包含 `manifest.json` 的目录
- **Firefox**：访问 `about:debugging#/runtime/this-firefox` →「临时载入附加组件」→ 选择 `manifest.json`（未签名扩展重启后失效，属浏览器限制）

### 从源码构建

```bash
git clone https://github.com/Lokeily/hao-fan.git
cd hao-fan
npm install
npm run build        # Chrome MV3 → .output/chrome-mv3
npm run build:firefox # Firefox MV2 → .output/firefox-mv2
```

商店上架推进中（Chrome Web Store / Edge / Firefox AMO），提交清单见 [docs/STORE_SUBMISSION.md](./docs/STORE_SUBMISSION.md)。

## ⌨️ 快捷键

| 快捷键 | 功能 |
| --- | --- |
| <kbd>Alt</kbd>+<kbd>T</kbd> | 翻译当前网页（可在浏览器扩展快捷键设置中自定义） |

## ⚙️ 配置参考

| 配置 | 说明 | 默认 |
| --- | --- | --- |
| 翻译引擎 / 模型 / Base URL | 服务商、模型与自建端点 | mymemory（免 Key） |
| 源语言 / 目标语言 | 支持自动检测 | 自动检测 → 中文 |
| 翻译模式 | `manual` 手动点击·划词 / `auto` 整页自动 | manual |
| 翻译风格 | 自然流畅 / 正式书面 / 轻松口语 / 简洁精炼 | 自然流畅 |
| 译文显示样式 | plain / dashed / underline / highlight | plain |
| 界面主题 | 跟随系统 / 强制浅色 / 强制深色 | 跟随系统 |
| 流式输出 / 上下文感知 / 质量自检 | 三项智能增强开关 | 全部开启 |
| 句子级缓存 / 翻译缓存 / 术语库 | 省 Token 三件套 | 开启 |
| 术语注入上限 | 每批注入术语条数（0 关闭） | 12 |
| 备用引擎 / 长文强模型 | 故障转移与长文路由 | 关闭 |
| 系统提示词 / 术语表 | 高级自定义 | 空 |

<details>
<summary><strong>支持的翻译服务</strong></summary>

| 类别 | 服务 |
| --- | --- |
| AI（12 家） | DeepSeek · OpenAI · Google Gemini · OpenRouter · 智谱 GLM · 腾讯混元 · 通义千问 · Kimi · 百川智能 · 豆包 · Ollama（本地）· 任意 OpenAI 兼容自定义接口 |
| 传统机翻 | MyMemory（免 Key）· Apertium（免 Key，欧洲语对）· DeepL · Microsoft 翻译 |

> MyMemory / Apertium 为免 Key 公共通道，无服务等级保证；正式使用建议配置带 Key 的服务。Ollama 本地模型数据不出本机。

</details>

## 🔒 隐私与安全

完整说明见 [PRIVACY.md](./PRIVACY.md) 与 [SECURITY.md](./SECURITY.md)。

- API Key 仅存本地浏览器（`storage.local`），按服务商隔离，仅经 `Authorization` 头直发所选服务商
- 待译文本以「数据而非指令」边界包裹，双层防护 Prompt Injection
- 全仓零 `innerHTML`：译文一律 `textContent` + Shadow DOM 注入，无 XSS 注入面
- 权限最小化（`storage` / `activeTab` / `contextMenus` / `scripting` 四项均有明确用例）
- 无遥测、无广告追踪；缓存 30 天 LRU 2000 条上限，可在设置中清空或关闭

## 🧪 开发与质量保障

```bash
npm install
npm run dev            # 开发模式
npm run test:all       # 一键执行全部门禁
```

| 门禁 | 内容 |
| --- | --- |
| `check:version` | 版本一致性（package / lock / README / changelog） |
| `lint` + `typecheck` | ESLint 0 警告 · TypeScript 严格模式 0 错误 |
| `test` | 66 项单元测试（协议 / 缓存 / 术语 / 流式 / 恢复 / 注入防护 / 备份 / 历史） |
| `build` × 2 | Chrome MV3 与 Firefox MV2 双平台构建 |
| `test:browser` | 33 项 Playwright 浏览器回归（布局 / 竞态 / 同步 / 性能基准 2001 段） |

架构与工作原理详见 [docs/features.html](./docs/features.html) 与审计档案（`功能审计-*.md` / `验证报告-*.md`）。

## 🤝 参与贡献

欢迎提交 Bug 报告、功能建议与代码。请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)，遵守 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。安全漏洞请按 [SECURITY.md](./SECURITY.md) 私下联系维护者，**不要**公开到 Issue。

## 📄 许可证

[MIT](./LICENSE) © 2026 好翻 (Haofan) contributors

---

<div align="center">

如果这个项目对你有帮助，欢迎点一个 ⭐ 支持开源！

</div>
