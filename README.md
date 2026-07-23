# 好翻 · Open Translator CN

<p align="center">
  <img src="public/icon-128.png" alt="好翻" width="96" height="96">
</p>

<p align="center">
  <strong>开源、免费的沉浸式 AI 翻译浏览器插件，国内大模型优先。</strong>
</p>

<p align="center">
  <a href="#-快速开始"><img src="https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white" alt="Chrome"></a>
  <a href="#-快速开始"><img src="https://img.shields.io/badge/Firefox-MV2-FF7139?logo=firefoxbrowser&logoColor=white" alt="Firefox"></a>
  <a href="#-快速开始"><img src="https://img.shields.io/badge/Edge-兼容-0078D7?logo=microsoftedge&logoColor=white" alt="Edge"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"></a>
  <a href="#"><img src="https://img.shields.io/badge/version-0.1.1-blue" alt="v0.1.1"></a>
  <img src="https://img.shields.io/badge/WXT-0.20-blueviolet" alt="WXT">
</p>

---

**好翻** 是一款在浏览器里直接工作的 AI 翻译工具。你用自己的 API Key 连接大模型，翻译请求从浏览器直发服务商，不经过任何中转服务器。没有月费，没有用量限制，数据只留在你手里。

> "翻译，本就该这样简单和透明。"

---

## 为什么选择好翻

| 特性 | 说明 |
|------|------|
| 🔑 **数据自主** | API Key 只存本地，请求直连服务商，零中转 |
| 🧠 **15 家引擎** | DeepSeek / OpenAI / Gemini / 智谱 / 混元 / 千问 / Kimi / 百川 / 豆包 / Ollama 本地 + Google / DeepL / Microsoft 传统翻译 |
| 👁️ **图片翻译** | 右键网页图片或本地上传，视觉模型 OCR + 译文中文叠加 |
| 💰 **省 Token 设计** | 视口优先翻译 · 本地缓存 · 术语库零请求命中 · 目标语言自动跳过 · 重复文本合并 · 实时用量面板 |
| 🌊 **动态内容** | 页面弹出菜单、无限滚动、异步加载内容自动检测并翻译 |
| ⚡ **低延迟** | 首屏小批次优先返回，滚动内容按需加载，不翻不译 |
| 🎯 **精准回填** | 带 ID 的 JSON 批量协议，不怕分隔符被模型改写造成错位 |
| 🎨 **沉浸式** | 译文直接插入原文下方，继承字体颜色对齐，Shadow DOM 隔离站点样式 |
| 📦 **双平台** | Chrome / Edge / Firefox 一套代码构建 |

---

## 三种用法

### 1. 网页翻译

访问任意网页，点右下角蓝色的「**译**」按钮，或右键菜单选择「翻译本页（好翻）」。

- 首屏内容秒出双语对照，滚动时继续按需翻译
- 动态弹出的菜单、弹窗、无限滚动内容自动跟进翻译
- 翻译中可随时点击「取消翻译」停止 Token 消耗

### 2. 划词翻译

在网页上选中一段文字，松开鼠标，译文气泡随即出现。

### 3. 图片翻译

- **右键网页图片** →「翻译图片（好翻）」：译文悬浮面板出现在图片旁边，原图叠加半透明翻译框，侧边对照原文/译文
- **弹窗上传** → 适合没有网页图片锚定的场景，结果在新标签页展示

> 图片翻译需要支持视觉的模型：GPT-4o、Gemini、GLM-4V、千问 VL、豆包 vision 等。Google 翻译是纯文本引擎，不支持图片。

---

## 支持的翻译引擎

### LLM（大语言模型）

| 引擎 | 视觉 | 免 Key | 默认模型 |
|------|:---:|:-----:|----------|
| DeepSeek | | | `deepseek-chat` |
| OpenAI (GPT) | ✅ | | `gpt-4o-mini` |
| Google Gemini | ✅ | | `gemini-2.0-flash` |
| OpenRouter | ✅ | | `openai/gpt-4o-mini` |
| 智谱 GLM | ✅ | | `glm-4.5-flash` |
| 腾讯混元 | ✅ | | `hunyuan-turbos-latest` |
| 通义千问 | ✅ | | `qwen-plus` |
| Kimi（月之暗面） | | | `moonshot-v1-8k` |
| 百川智能 | | | `baichuan4` |
| 豆包（火山方舟） | ✅ | | `doubao-lite-32k` |
| Ollama（本地） | ✅ | ✅ | `qwen2.5` |
| 自定义（OpenAI 兼容） | 可选 | | — |

### 传统机器翻译

| 引擎 | 免 Key |
|------|:-----:|
| Google 翻译 | ✅ |
| DeepL | |
| Microsoft 翻译 | |

> 全部 LLM 引擎走 OpenAI 兼容协议，一套适配器通吃。视觉模型走多模态消息。

---

## 快速开始

### 安装

从 [Releases](https://github.com/your-username/open-translator-cn/releases) 下载对应浏览器的 `.zip` 包：

- `open-translator-cn-x.x.x-chrome.zip` → Chrome / Edge
- `open-translator-cn-x.x.x-firefox.zip` → Firefox

然后打开浏览器扩展管理页面加载：

- Chrome / Edge：`chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」
- Firefox：`about:debugging#/runtime/this-firefox` →「临时载入附加组件」

### 开发

```bash
git clone https://github.com/your-username/open-translator-cn.git
cd open-translator-cn
npm install
npm run dev          # Chrome 开发模式，支持热重载
```

在浏览器加载 `.output/chrome-mv3/dev` 目录即可。

### 构建

```bash
npm run build           # Chrome/Edge 生产构建
npm run zip             # 生成 Chrome/Edge ZIP 包
npm run build:firefox   # Firefox 生产构建
npm run zip:firefox     # 生成 Firefox ZIP 包
```

构建产物位于 `.output/`。

---

## 配置

安装后点击插件图标 →「设置」标签页：

1. **选择翻译引擎** — 如 DeepSeek、智谱、OpenAI
2. **选择模型** — 使用预设，或选择「自定义模型」填入新模型名
3. **填入 API Key** — 每个服务商独立保存，切换引擎不会错发 Key
4. **设置源语言与目标语言** — 默认「自动检测」→「中文」
5. **可选**：自定义系统提示词、术语表、翻译风格；自定义接口可手动开启视觉能力

点击「测试连接」验证配置是否正确。

各厂商 API Key 申请地址见 `utils/providers.ts` 中的 `docUrl` 字段。

---

## 目录结构

```
open-translator-cn/
├── entrypoints/
│   ├── background.ts          # Service Worker：消息路由 / API 调用 / 右键菜单
│   ├── content.ts             # 内容脚本：文本提取 / 译文注入 / 划词气泡 / 悬浮按钮
│   ├── image-translate.html   # 图片翻译结果页
│   ├── options.ts             # 设置页
│   └── popup.ts               # 弹窗（快速翻译 + 图片上传 + 配置入口）
├── utils/
│   ├── providers.ts           # 15 家引擎预设（LLM / MT / vision 标记）
│   ├── translator.ts          # OpenAI 兼容调用 + 批量翻译 + 传统 MT
│   ├── vision.ts              # 视觉模型图片翻译（OCR + 坐标）
│   ├── languages.ts           # 18 种语言映射
│   ├── cache.ts               # 翻译缓存
│   ├── storage.ts             # 配置持久化
│   ├── dom.ts                 # 网页文本提取
│   └── ui.ts                  # 设置 / 弹窗共用表单
├── styles/                    # 样式
├── tests/                     # 单元测试
├── scripts/                   # 构建与 CI 辅助脚本
├── wxt.config.ts              # WXT 配置
├── tsconfig.json
└── package.json
```

---

## 隐私与安全

- 你的 **API Key 仅保存在浏览器本地**（`storage.local`），随请求直发所选服务商
- 翻译请求由浏览器扩展**直接发起**，不经过本项目的中转服务器
- 项目**没有遥测、广告追踪或数据收集**
- 已显式声明 CSP（`script-src 'self'`），禁止内联/远程脚本
- 翻译缓存保存在本地，含 30 天 TTL 与容量上限，可在设置中关闭
- `<all_urls>` 权限用于内容脚本跨域读取网页以及后台调用用户所选大模型 API

---

## 路线图

- [ ] PDF / ePub 翻译
- [ ] YouTube / 流媒体字幕双语
- [ ] TTS 朗读（Edge TTS）
- [ ] 油猴脚本版本（免安装）
- [ ] 跨设备配置同步

---

## 许可证

[MIT](./LICENSE) — 自由使用、修改、再分发。
