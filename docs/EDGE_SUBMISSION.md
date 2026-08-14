# Edge 浏览器扩展上架指南（Microsoft Edge Add-ons）

本文档是「好翻」在 **Microsoft Edge Add-ons** 商店上架的完整实操步骤与文案模板。
Edge 商店免费、审核较快（通常 1–7 个工作日），且支持「从 Chrome Web Store 一键同步」列表。

---

## 0. 准备材料（约 15 分钟）

| 材料 | 状态 | 说明 |
| --- | --- | --- |
| 微软账号 | 需注册 | partner.microsoft.com 登录用，免费 |
| 扩展包 | ✅ 已有 | `open-translator-cn-x.x.x-chrome.zip`（Edge 与 Chrome 同内核，直接使用 Chrome 包） |
| 图标 128×128 | ✅ 已有 | `public/icon-128.png`（manifest 已引用） |
| 截图 | ⚠️ 需补充 | 建议 5 张 1280×800：弹窗、设置页（浅色）、整页翻译效果、悬停翻译、深色模式 |
| 隐私政策 URL | ⚠️ 需托管 | 将 `PRIVACY.md` 发布到可公开访问的 URL（见第 5 节） |
| 商店文案 | ✅ 本文档提供 | 见第 4 节，可直接复制 |

---

## 1. 注册开发者账号

1. 打开 <https://partner.microsoft.com/dashboard/microsoftedge>
2. 使用微软账号登录（个人邮箱即可注册；企业账号可选）
3. 首次进入会要求阅读并同意「Microsoft Edge 加载项开发者协议」
4. 完善开发者信息（显示名称、联系邮箱——用于用户反馈渠道）
5. 完成验证后进入 Dashboard，点击 **Create new extension**（创建新扩展）

> 注意：Edge 开发者中心允许免费注册，**不需要任何费用**（与 Chrome Web Store 的 5 USD 一次性费用不同）。

---

## 2. 创建扩展提交（表单逐项说明）

### 2.1 Extension name（扩展名称）
```
好翻 · Open Translator CN
```
> 建议附带英文名，便于搜索收录。

### 2.2 Short description（简短描述，≤ 100 字符）
```
开源、免费的沉浸式 AI 网页翻译扩展。保留原文、译文对照显示；支持 DeepSeek、OpenAI、智谱等 15+ 服务商与本地模型。
```

### 2.3 Long description（详细描述，可粘贴）
```
好翻（Open Translator CN）是一款开源免费的沉浸式双语网页翻译扩展。

## 核心功能
- 沉浸式双语对照：保留网页原文，译文显示在原文下方，逐段对照阅读
- 流式输出：首段边生成边显示，首字延迟低至毫秒级
- 悬停翻译：鼠标悬停段落即可查看译文气泡
- 划词翻译：选中文字即译，独立浮窗展示
- 输入框翻译：网页输入框聚焦时提供翻译入口
- 图片翻译：网页图片与本地图片 OCR + 翻译（需视觉模型）
- 动态内容翻译：弹窗、菜单、无限滚动内容自动补译
- 上下文感知：结合页面标题与前段译文，长文更连贯
- 质量自检：数字 / URL / 代码 token 保真校验，缺失自动校正并提示
- 译文可编辑：hover 译文即可修改，自动沉淀进个人术语表
- 多引擎路由：备用引擎故障转移 + 长文强模型路由
- 极致省 Token：句子级缓存、术语库零请求命中、术语注入上限可调

## 支持的翻译服务
- AI：DeepSeek、OpenAI、Google Gemini、OpenRouter、智谱 GLM、腾讯混元、通义千问、Kimi、百川智能、豆包、Ollama 本地模型、任意 OpenAI 兼容接口
- 传统翻译：Google 翻译（免 Key）、DeepL、Microsoft 翻译

## 隐私
- API Key 仅保存在浏览器本地，按服务商隔离，直连所选服务商
- 无遥测、无广告追踪、无用户行为统计
- 翻译请求不经过任何中转服务器
- 详见隐私政策：<你的隐私政策 URL>

## 使用
1. 点击工具栏「好翻」图标 → 设置
2. 选择服务商并填写 API Key，点击「测试连接」
3. 回到网页，点击右下角「译」按钮开始翻译
4. 快捷键 Alt+T 可直接翻译当前网页
```

### 2.4 Category（类别）
选择 **Productivity（生产力）**

### 2.5 Icons（图标）
上传 `public/icon-128.png`（128×128 PNG）。

### 2.6 Screenshots（截图，5 张最佳）
| 截图 | 内容建议 |
| --- | --- |
| 1 | 弹窗界面（浅色） |
| 2 | 设置页（浅色，可展示宽屏双栏） |
| 3 | 网页整页翻译效果（中英对照） |
| 4 | 悬停翻译气泡 |
| 5 | 深色模式下的设置页或弹窗 |

### 2.7 Privacy policy URL（隐私政策 URL，必填）
见第 5 节，粘贴托管后的 URL。

### 2.8 Permissions（权限说明，逐项粘贴）
```
- storage：在本地保存你的设置、翻译缓存与 API Key（Key 不会离开你的设备，除非发送给你选择的翻译服务商）
- activeTab / scripting：在你点击翻译时向当前页面注入翻译脚本
- contextMenus：提供「翻译本页 / 翻译图片 / 翻译选中内容」右键菜单
- <all_urls> 主机权限：在任意网页注入翻译脚本，并直连你在设置中选择的翻译服务
扩展不会在未经你操作的情况下发起任何翻译请求。
```

### 2.9 Test notes / additional info（测试说明，选填）
```
测试入口：点击工具栏图标打开弹窗；在任意网页点击右下角「译」按钮可整页翻译；
鼠标悬停段落可查看译文；快捷键 Alt+T 翻译当前网页。
默认服务商为 DeepSeek（需用户自备 API Key），选择「Google 翻译」可免 Key 体验。
```

---

## 3. 上传包与提交

1. 在表单底部 **Upload package** 选择 `open-translator-cn-x.x.x-chrome.zip`
2. 点击 **Save draft**（保存草稿）
3. 确认所有必填项后点击 **Submit for review**（提交审核）
4. 审核状态：Dashboard → Extensions 列表可见；通过后 **Publish** 发布

> 提交前用本地浏览器自测一遍：`chrome://extensions` 加载同一 zip 解压目录，确认
> 弹窗、整页翻译、设置页、图片翻译均可正常使用。

---

## 4. 审核常见驳回原因与规避

| 原因 | 规避 |
| --- | --- |
| 隐私政策 URL 不可访问 | 用 GitHub Pages / Gist 托管，提交前浏览器匿名窗口打开验证 |
| 权限与功能不符 | 本扩展权限逐项说明见 2.8，勿夸大 |
| 描述含虚假承诺 | 不要写「免费无限额度」——AI 服务由第三方计费，明确写「用户自备 API Key」 |
| 截图与功能不符 | 截图须真实反映界面 |

---

## 5. 托管隐私政策（二选一）

### 方式 A：GitHub Pages（推荐）
```bash
# 1. 在 GitHub 仓库开启 Pages（Settings → Pages → Deploy from branch → main → / (root)）
# 2. 在仓库根目录创建 index.md（或直接让 PRIVACY.md 可访问）
# 3. 访问 https://<你的用户名>.github.io/hao-fan/ 即为隐私政策 URL
```

### 方式 B：Gist（最快）
1. 打开 <https://gist.github.com> 粘贴 `PRIVACY.md` 内容 → 创建
2. Gist 页面 URL（`https://gist.github.com/<用户名>/<id>`）即为隐私政策 URL
3. 建议勾选 Public

---

## 6. 从 Chrome Web Store 同步（可选）

如果后续同时上架 Chrome Web Store：
1. Edge Dashboard → 扩展详情 → **Sync with Chrome Web Store**
2. 授权后，CWS 的列表可一键同步到 Edge（名称/描述/截图自动带入）
3. 注意：同步后仍需在 Edge 侧补充隐私政策 URL 与权限说明

---

## 7. 发布后日常

- **更新版本**：发新 Release → 下载新 zip → Dashboard 上传新包 → Submit
- **用户反馈**：商店评论区 + GitHub Issues（README 已提供入口）
- **数据观察**：Edge Dashboard 提供安装量/评分统计

---

## 8. 待办清单

- [ ] 注册微软账号并登录 Partner Center
- [ ] 补充 5 张商店截图（弹窗/设置/整页翻译/悬停翻译/深色模式）
- [ ] 托管 PRIVACY.md 为公开 URL
- [ ] 发布最新版本（含悬停翻译等新功能的 v0.1.8）并取得 zip
- [ ] 按第 2 节填写表单并提交审核
