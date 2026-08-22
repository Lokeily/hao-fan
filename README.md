# 好翻 · Open Translator CN

<p align="center">
  <img src="public/icon-128.png" alt="好翻" width="96" height="96">
</p>

<p align="center">
  <strong>开源、免费、直连自选 AI 的沉浸式双语网页翻译扩展</strong>
  <br />
  <em>An open-source immersive bilingual web translation extension that talks directly to the model provider you choose.</em>
</p>

<p align="center">
  <a href="https://github.com/Lokeily/hao-fan/actions/workflows/build.yml"><img src="https://github.com/Lokeily/hao-fan/actions/workflows/build.yml/badge.svg?branch=main" alt="Build"></a>
  <a href="#安装"><img src="https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white" alt="Chrome"></a>
  <a href="#安装"><img src="https://img.shields.io/badge/Firefox-MV2-FF7139?logo=firefoxbrowser&logoColor=white" alt="Firefox"></a>
  <a href="#安装"><img src="https://img.shields.io/badge/Edge-compatible-0078D7?logo=microsoftedge&logoColor=white" alt="Edge"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"></a>
  <a href="https://github.com/Lokeily/hao-fan/releases/latest"><img src="https://img.shields.io/badge/version-0.1.23-blue" alt="v0.1.23"></a>
</p>

---

## 简介

「好翻」是一款把**译文嵌进原文**的浏览器翻译扩展：保留网页原文不动，在每一段原文下方渲染译文，逐段对照阅读，不破坏原页面结构与排版。

与云端聚合翻译服务不同，好翻**直连你自己配置的翻译服务商**——请求不经过任何中转服务器，API Key 只保存在本机浏览器，不向第三方上传浏览内容。它对"翻译"这件事的态度是：

- **无中心**：谁给你翻译，由你决定。内置 12 家国内 / 国际 AI 服务商、任意 OpenAI 兼容接口与本地模型，外加 3 家传统机器翻译。
- **无遥测**：不采集使用行为，无广告追踪，无使用额度。
- **可解释**：每项行为都能在源码中找到对应实现（见[工作原理](#工作原理)），透明可审计。

## 功能特性

| 功能 | 说明 |
| --- | --- |
| 沉浸式双语对照 | 原文保留，译文以独立节点渲染在原文下方（Shadow DOM），随页面滚动自然跟随 |
| 流式输出 | 划词 / 悬停 / 点段落 / 输入框等单条翻译走长连接流式回填，首字即显；端口异常自动回退普通请求，不漏译 |
| 上下文感知翻译 | 结合页面标题与前段译文构造滑动窗口，长文代词指代与术语更连贯 |
| 翻译质量自检 | 译后校验原文中的数字 / URL / 邮箱 / 占位符 / 代码 token 是否完整保留，缺失自动校正重试并标记提示 |
| 可见区域优先 | 先翻译首屏，滚动中按需翻译新进入视口的内容 |
| 动态内容翻译 | 弹窗、菜单、无限滚动等异步加载的内容自动补译；8 秒冷却 + 仅数字变化就地更新，避免行情 / 时钟类元素反复消耗 Token |
| 划词翻译 | 选中文字即译，结果在独立浮层展示，不改写网页 |
| 悬停翻译 | 鼠标悬停段落即出译文气泡（可关闭） |
| 手动翻译模式 | 自动整页与「点击段落 / 划词」手动模式可切换，Token 开销最小 |
| 智能语言检测 | 逐段检测语种，已是目标语言即本地跳过（0 Token），杜绝「中译中」 |
| 代码 / 库名保护 | `useState`、`react-dom`、React、Vue 等标识符与品牌专名先占位、译后还原，库名不被翻译 |
| 译文可编辑 · 术语自学习 | 悬停译文即可修改，改动自动沉淀进个人术语表并即时生效 |
| 图片翻译 | 网页图片与本地图片 OCR + 翻译（需支持视觉的模型） |
| 按网站暂停 / 自动翻译 | 一键暂停本站并清理译文，或记忆「总是自动翻译本站」偏好 |
| 多引擎路由 | 主引擎限流 / 报错自动切换备用引擎；长文本自动路由到强模型 |
| 可拖动工具栏 | 「译 + 设置」悬浮按钮组可拖动并记忆位置 |
| 页内快速设置 | 网页内直接弹出设置面板，即改即生效 |
| 键盘快捷键 | `Alt+T` 一键翻译当前网页（可在浏览器设置页改键） |
| 自定义能力 | 服务商、模型、Base URL、系统提示词、术语表、翻译风格均可配置 |

## 工作原理

### 分层架构

好翻遵循 Manifest V3 的生命周期约束，职责边界清晰：

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 内容脚本 | `entrypoints/content.ts` | 页面文本提取、翻译触发、译文渲染、动态内容观察 |
| 后台 Service Worker | `entrypoints/background.ts` | 密钥管理、翻译 API 调用、统计持久化 |
| 设置界面 | `entrypoints/options.html`、`src/pages/popup.ts` | 配置表单、Token 统计、图片翻译入口 |
| 协议层 | `utils/batch-protocol.ts`、`utils/requester.ts` | 批量 JSON 协议、OpenAI 兼容请求 / SSE 流式 |
| 核心翻译 | `utils/translator.ts` | 路由、缓存、术语、自检、错误恢复 |
| 渲染层 | `utils/content-ui.ts` | 译文节点、弹窗、设置面板等全部 UI 组件 |

内容脚本与后台通过 `runtime` 消息（批量 / 单条）与长连接端口（`haofan-stream`，流式）通信，契合 MV3 Service Worker 可被随时回收的特性。

### 一条译文的生产流水线

```
网页文本 → 标识符遮罩 → 提示词组装 → 引擎路由 → 请求 / 流式 → 译后自检 → 还原占位符 → 渲染 → 缓存
```

1. **标识符遮罩**（`utils/mask.ts`）：把代码 / 库名形态替换成私有区字符占位符，模型只译自然语言，译后再还原——库名不会被翻译，占位符比译文短，顺带省 completion Token。
2. **提示词组装**（`utils/translator.ts`）：系统提示词前缀稳定（利于供应商提示词缓存）；待译文本用 `<<<TRANSLATE_DATA>>>` 边界包裹，声明为「数据而非指令」。
3. **引擎路由**：长文本（超过阈值）自动切换到「强模型」；主引擎 401 / 403 / 限流 / 额度不足时按 `fallbackProviders` 顺序故障转移。
4. **请求 / 流式**：单条交互走 SSE 长连接逐字回填；整页翻译走批量协议一次请求译多段，协议失败时拆半恢复、逐条兜底（恢复深度受预算约束，保证终止）。
5. **译后自检**（`auditTranslation`）：校验数字 / URL / 代码 token 保真度，缺失则校正重试一次，仍缺失保留首版并在界面标记。
6. **渲染**：译文一律经 `textContent` 写入 Shadow DOM，从根上排除 XSS；流式增量经 `restorePartial` 还原占位符，界面不闪现遮罩字符。

### 省 Token 的经济性

翻译是花真金白银的，好翻把「省」做成了体系，多层叠加：

| 机制 | 原理 |
| --- | --- |
| 句子级缓存 | 按句缓存 + 归一化匹配，SPA 微变只重译变化句；缺失句合并为**一次**批量请求（不再逐句串行重复发提示词前缀） |
| 整段缓存 | 30 天 LRU（2000 条），重复内容 0 请求 |
| 术语库命中 | 本地命中即返回，0 请求 |
| 智能语言跳过 | 已是目标语言，本地跳过，0 Token |
| 动态内容节流 | 8 秒冷却合并抖动；仅数字变化就地更新译文，0 请求 |
| 术语注入上限 | 提示词注入的术语条数可调（0–24），越低越省 |
| 标识符占位 | 占位符比原文标识符短，减少 completion |

### 安全性设计

- **注入防护**：网页标题、前文等不可信内容被显式降级为「数据而非指令」，追加到**用户消息**末尾（而非系统提示词）；恶意 `<title>` 无法操纵译文。
- **密钥管理**：API Key 仅存 `storage.local`，发送前经 `cleanSecret` 净化；仅通过 `Authorization` 头传输，绝不进入 URL；按服务商隔离。
- **XSS 免疫**：全仓零 `innerHTML` / `insertAdjacentHTML`，译文全部 `textContent` + Shadow DOM 注入。
- **权限最小化**：仅申请 `storage` / `activeTab` / `contextMenus` / `scripting` 四项权限，均有明确用例。
- **严格 CSP**：扩展页面 `script-src 'self'`，禁止远程脚本。

## 支持的翻译服务

| 类别 | 服务 |
| --- | --- |
| AI（12 家） | DeepSeek · OpenAI · Google Gemini · OpenRouter · 智谱 GLM · 腾讯混元 · 通义千问 · Kimi · 百川智能 · 豆包 · Ollama（本地）· 任意 OpenAI 兼容自定义接口 |
| 传统机器翻译（3 家） | Google 翻译（免 Key）· DeepL · Microsoft 翻译 |

> Google 翻译（免 Key）走非官方免费端点，无服务等级保证，偶尔限流或临时不可用，适合体验；正式使用建议配置带 API Key 的服务。Ollama 等本地模型无需 Key，数据不出本机。

## 安装

1. 打开 [Releases](https://github.com/Lokeily/hao-fan/releases/latest)，下载对应浏览器的 ZIP 并解压。
2. **Chrome / Edge**：访问 `chrome://extensions`（Edge 为 `edge://extensions`）→ 开启「开发者模式」→「加载已解压的扩展程序」→ 选择解压后**直接包含 `manifest.json`** 的目录。
3. **Firefox**：访问 `about:debugging#/runtime/this-firefox` →「临时载入附加组件」→ 选择解压目录中的 `manifest.json`。未签名扩展在浏览器重启后消失，属浏览器限制。

上架工作推进中（Chrome Web Store / Edge / Firefox AMO），提交清单见 [docs/STORE_SUBMISSION.md](./docs/STORE_SUBMISSION.md)；上架后将获得自动更新。

## 快速开始

1. 点击工具栏「好翻」图标 → 打开「设置」。
2. 选择服务商，填入 API Key，设置目标语言，点「测试连接」确认可用。
3. 回到网页，点击右下角蓝色「译」按钮开始翻译；翻译中再次点击可取消。

**想先体验？** 设置中选择「Google 翻译」即可免 Key 使用。
**追求最省 Token？** 把「翻译模式」切到「手动点击 / 划词」——整页不自动翻译，点哪段译哪段。
**还没配 Key？** 好翻不会发送任何无效请求，而是弹出一次性引导卡，填好 Key 后自动继续翻译。

## 配置参考

| 配置 | 说明 | 默认 |
| --- | --- | --- |
| 翻译引擎 / 模型 / Base URL | 服务商、模型与自建端点 | deepseek / deepseek-chat |
| 源语言 / 目标语言 | 支持自动检测 | 自动检测 → 中文 |
| 翻译模式 | `auto` 整页自动 / `manual` 手动点击·划词 | auto |
| 翻译风格 | 自然流畅 / 正式书面 / 轻松口语 / 简洁精炼 | 自然流畅 |
| 译文显示样式 | plain / dashed / underline / highlight | plain |
| 流式输出 / 上下文感知 / 质量自检 | 三项智能增强开关 | 全部开启 |
| 句子级缓存 / 翻译缓存 / 术语库 | 省 Token 三件套 | 开启 |
| 术语注入上限 | 每批注入术语条数（0 关闭） | 12 |
| 备用引擎 / 长文强模型 | 故障转移与长文路由 | 关闭 |
| 系统提示词 / 术语表 | 高级自定义 | 空 |

## 隐私与安全

完整说明见 [PRIVACY.md](./PRIVACY.md) 与 [SECURITY.md](./SECURITY.md)。

- API Key 仅存本地浏览器（`storage.local`），按服务商隔离，直发所选服务商；无遥测、无广告追踪、无行为统计。
- 待译文本带注入防护边界；译文仅以 `textContent` 注入，无 XSS 面。
- 本地翻译缓存默认 30 天有效期与 LRU 2000 条上限，可在设置中关闭。
- 网站暂停列表、工具栏位置等偏好仅存本地。

## 开发与质量保障

```bash
git clone https://github.com/Lokeily/hao-fan.git
cd hao-fan
npm install
npm run dev             # 开发模式（.output/chrome-mv3-dev）
```

质量门禁（`npm run test:all` 一键执行全部）：

```bash
npm run check:version   # 版本一致性（package / lock / README / changelog）
npm run typecheck       # TypeScript 类型检查
npm run lint            # ESLint
npm test                # 单元测试（协议 / 缓存 / 术语 / 流式 / 恢复 / 注入防护等）
npm run build           # 构建
npm run test:browser    # Playwright 浏览器回归（布局 / 竞态 / 性能 / 引导等）
```

- 当前状态：**45 项单元测试 + 32 项浏览器回归全部通过**，双平台（Chrome MV3 / Firefox MV2）构建与商店打包验证通过。
- 双平台构建：`npm run build`（Chrome）、`npm run build:firefox`（Firefox）。
- 商店打包：`npm run zip`、`npm run zip:firefox`。
- 本仓库的审计与验证记录见 `功能审计-2026-08-15.md` 与 `验证报告-2026-08-22.md`（含可行性 / 安全性 / 稳定性三维度结论）。

## 项目结构

```
entrypoints/          内容脚本、后台、设置页（popup / options / image-translate）
src/pages/            弹窗与设置页入口逻辑
utils/                翻译核心、批量协议、请求层、缓存、术语、渲染组件、站点策略
styles/               内容脚本与设置页样式
tests/                单元测试（node:test）与浏览器回归（Playwright）
docs/                 GitHub Pages 官网源码与商店上架文档
.github/workflows/    CI 构建与发布
```

## 参与贡献

欢迎提交 Bug 报告、功能建议与代码。请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)，并遵守 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。安全漏洞请按 [SECURITY.md](./SECURITY.md) 私下联系维护者，**不要**公开到 Issue。

## 许可证

[MIT](./LICENSE) © 2026 好翻 (Haofan) contributors
