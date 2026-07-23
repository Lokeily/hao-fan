# 好翻 Open Translator CN

<p align="center">
  <img src="public/icon-128.png" alt="好翻" width="96" height="96">
</p>

<p align="center">
  <strong>免费、开源、可以使用自己 API 的双语网页翻译扩展。</strong>
</p>

<p align="center">
  <a href="https://github.com/Lokeily/Hao-Fan-/actions/workflows/build.yml"><img src="https://github.com/Lokeily/Hao-Fan-/actions/workflows/build.yml/badge.svg?branch=main" alt="Build"></a>
  <a href="#安装扩展"><img src="https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white" alt="Chrome"></a>
  <a href="#安装扩展"><img src="https://img.shields.io/badge/Firefox-MV2-FF7139?logo=firefoxbrowser&logoColor=white" alt="Firefox"></a>
  <a href="#安装扩展"><img src="https://img.shields.io/badge/Edge-compatible-0078D7?logo=microsoftedge&logoColor=white" alt="Edge"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"></a>
  <a href="https://github.com/Lokeily/Hao-Fan-/releases/latest"><img src="https://img.shields.io/badge/version-0.1.2-blue" alt="v0.1.2"></a>
</p>

## 这是什么

好翻是一款浏览器翻译扩展。翻译后会保留网页原文，并把译文自然地显示在原文下面，方便逐段对照阅读。

扩展本身免费，不设置使用额度。你可以连接自己的 DeepSeek、OpenAI、Gemini、智谱、通义千问等 API，也可以使用 Ollama 本地模型或传统机器翻译。

需要注意：第三方 AI 服务可能收费，具体价格和额度由对应服务商决定。

## 目录

- [主要功能](#主要功能)
- [安装扩展](#安装扩展)
- [第一次使用](#第一次使用)
- [三种翻译方式](#三种翻译方式)
- [支持的服务](#支持的服务)
- [怎样节省 Token](#怎样节省-token)
- [常见问题](#常见问题)
- [隐私与权限](#隐私与权限)
- [问题反馈](#问题反馈)
- [参与社区](#参与社区)
- [开发者说明](#开发者说明)
- [许可证](#许可证)

## 主要功能

| 功能 | 说明 |
|------|------|
| 网页双语翻译 | 原文保留，译文显示在原文下方 |
| 可见区域优先 | 先翻译当前屏幕内容，滚动后再翻译新内容 |
| 动态内容翻译 | 菜单、弹窗、无限滚动和异步加载内容会自动补译 |
| 划词翻译 | 选中文字后显示独立翻译窗口，不修改原网页文字 |
| 图片翻译 | 支持网页图片和本地图片，需要使用支持视觉的 AI 模型 |
| 自定义 API | 支持预设服务商和 OpenAI 兼容接口 |
| 节省 Token | 使用缓存、重复文本合并、目标语言跳过和按需翻译 |
| 隐私保护 | API Key 保存在本地，翻译请求不经过项目中转服务器 |

## 安装扩展

### 第一步：下载安装包

打开 [Releases](https://github.com/Lokeily/Hao-Fan-/releases/latest)，在页面底部找到 Assets，然后下载对应文件：

| 文件 | 用途 |
|------|------|
| <code>open-translator-cn-x.x.x-chrome.zip</code> | Chrome、Edge 和其他 Chromium 浏览器 |
| <code>open-translator-cn-x.x.x-firefox.zip</code> | Firefox |
| <code>open-translator-cn-x.x.x-sources.zip</code> | 源码审核包，普通用户不需要下载 |

下载后先解压 ZIP。浏览器不能直接加载 ZIP 文件。

### 第二步：安装到 Chrome 或 Edge

1. 在地址栏输入 <code>chrome://extensions</code>。Edge 用户输入 <code>edge://extensions</code>。
2. 打开页面右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择刚刚解压的 Chrome 文件夹。
5. 浏览器工具栏出现“好翻”图标后，安装完成。

如果选错文件夹，请选择其中能够直接看到 <code>manifest.json</code> 的那一层目录。

### 第二步：安装到 Firefox

1. 在地址栏输入 <code>about:debugging#/runtime/this-firefox</code>。
2. 点击“临时载入附加组件”。
3. 打开解压后的 Firefox 文件夹。
4. 选择其中的 <code>manifest.json</code>。

通过这种方式安装的 Firefox 扩展在浏览器重启后会消失，这是 Firefox 对未签名扩展的限制。

## 第一次使用

### 只想先试一下

1. 点击浏览器工具栏中的“好翻”图标。
2. 打开“设置”。
3. 选择不需要 API Key 的“Google 翻译”。
4. 打开一个普通网页。
5. 点击网页右下角蓝色的“译”按钮。

### 使用自己的 AI

1. 点击浏览器工具栏中的“好翻”图标。
2. 打开“设置”。
3. 选择你使用的 AI 服务商。
4. 填写该服务商提供的 API Key。
5. 选择模型，初次使用建议先保留默认模型。
6. 设置目标语言，例如“中文”。
7. 点击“测试连接”。
8. 显示连接成功后，回到网页并点击右下角的“译”按钮。

设置修改后会自动保存。每个服务商的 API Key 分开保存，切换服务商时不会把 Key 发送到其他平台。

## 三种翻译方式

### 翻译整个网页

打开普通网页后，点击右下角蓝色的“译”按钮。也可以在网页空白处点击右键，然后选择“翻译本页（好翻）”。

扩展会先处理当前可见内容。向下或向上滚动时，新进入屏幕的内容会继续翻译。翻译过程中再次点击按钮可以取消任务。

### 划词翻译

用鼠标选中一段文字，松开鼠标后点击出现的“译”按钮。译文会显示在独立窗口中，不会改变原网页排版。

### 图片翻译

在网页图片上点击右键，然后选择“翻译图片（好翻）”。也可以在扩展弹窗中上传本地图片。

图片翻译需要支持视觉的模型，例如 GPT-4o、Gemini、GLM-4V、通义千问 VL 或豆包视觉模型。纯文本模型和传统机器翻译不能识别图片。

## 支持的服务

### AI 服务

- DeepSeek
- OpenAI
- Google Gemini
- OpenRouter
- 智谱 GLM
- 腾讯混元
- 通义千问
- Kimi
- 百川智能
- 豆包
- Ollama 本地模型
- 自定义 OpenAI 兼容接口

### 传统机器翻译

- Google 翻译
- DeepL
- Microsoft 翻译

不同模型的文字质量、图片能力、速度和价格不同。无法确定时，先使用服务商的默认文本模型完成连接测试。

## 怎样节省 Token

好翻会通过以下方式减少重复请求：

- 只优先翻译当前屏幕中能看到的内容。
- 已翻译内容保存在本地缓存中。
- 同一页面的重复文本只请求一次。
- 已经是目标语言的内容会自动跳过。
- 命中本地术语表时不调用 AI。
- 菜单或弹窗反复打开时复用已有译文。

关闭扩展的本地缓存后，重复内容可能重新请求翻译服务。

## 常见问题

### 点击翻译后提示没有填写 API Key

打开扩展设置，确认当前服务商对应的 API Key 已填写，然后点击“测试连接”。切换服务商后，需要填写新服务商自己的 Key。

### 安装后网页上没有“译”按钮

刷新已经打开的网页。浏览器扩展安装前打开的页面通常需要刷新后才能加载扩展。

浏览器设置页、扩展商店、空白新标签页等内部页面不允许扩展运行，这些页面无法翻译。

### 有些新出现的内容没有翻译

先让内容进入当前可见区域并稍等片刻。如果仍然没有翻译，请通过下方的问题反馈渠道提交页面地址和复现步骤。

### 译文显示错位或覆盖网页

请提供浏览器版本、网页地址、截图和复现步骤。不要在截图或日志中暴露 API Key。

### 扩展是否完全免费

扩展代码和功能免费。使用第三方 AI API 时，服务商可能按照 Token 或请求次数收费。使用 Ollama 本地模型时不需要云端 API Key。

### 如何更新扩展

下载新版 ZIP 并解压，用新版文件覆盖原来的扩展目录，然后在扩展管理页点击“重新加载”。不要先删除旧扩展，也不要随意更换目录，否则浏览器可能把它识别为新的扩展并丢失原配置。升级前仍建议记录自己的服务商和模型设置。

## 隐私与权限

- API Key 只保存在浏览器本地的 <code>storage.local</code> 中。
- 翻译内容直接发送给你选择的服务商，不经过本项目的中转服务器。
- 项目没有遥测、广告追踪或用户行为统计。
- 本地翻译缓存默认包含 30 天有效期和容量上限，可在设置中关闭。
- <code>&lt;all_urls&gt;</code> 权限用于在用户打开的网页中运行翻译脚本，并从后台连接所选翻译服务。
- 项目使用内容安全策略，禁止扩展页面加载远程脚本。

## 问题反馈

遇到漏译、译文错位、动态内容未翻译或其他问题，可以通过以下方式反馈：

- [提交 Bug 报告](https://github.com/Lokeily/Hao-Fan-/issues/new?template=bug_report.yml)
- [提出功能建议](https://github.com/Lokeily/Hao-Fan-/issues/new?template=feature_request.yml)
- 联系作者 QQ：<code>3084614411</code>

反馈时请尽量提供浏览器名称和版本、问题页面、截图以及复现步骤。请勿提交 API Key、账号密码或其他敏感信息。

## 参与社区

欢迎修正文档、补充测试、报告兼容性问题或提交代码。第一次参与开源项目也没有关系，可以从修改说明文字或提交可复现的 Bug 报告开始。

- 提交代码前请阅读 [贡献指南](./CONTRIBUTING.md)。
- 参与讨论和协作时请遵守 [社区行为准则](./CODE_OF_CONDUCT.md)。
- 安全漏洞不要发布到公开 Issue，请按照 [安全政策](./SECURITY.md) 联系作者。
- 每个版本的主要变化记录在 [更新日志](./CHANGELOG.md) 中。
- 所有参与者都应尊重他人，围绕技术事实进行讨论，不公开他人的隐私信息。

## 开发者说明

### 本地运行

~~~bash
git clone https://github.com/Lokeily/Hao-Fan-.git
cd Hao-Fan-
npm install
npm run dev
~~~

开发模式构建结果位于 <code>.output/chrome-mv3-dev</code>。在 Chrome 扩展管理页加载该目录即可。

### 测试和构建

~~~bash
npm test
npm run typecheck
npm run build
npm run zip
npm run build:firefox
npm run zip:firefox
~~~

正式构建和 ZIP 文件位于 <code>.output/</code>。

## 许可证

本项目使用 [MIT 许可证](./LICENSE)，允许使用、修改和再分发。
