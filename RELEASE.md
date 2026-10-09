# 发布质量手册（RELEASE）

> 每次对外发版前，跑一条命令：`npm run release`。
> 它依次执行：版本一致性 → ESLint → 91 条单元测试 → TypeScript 全量类型检查 → Chrome 构建 → Firefox 构建 → 双平台打包 → 79 条浏览器端到端回归。
> **任何一步失败，禁止发版。** 没有例外，没有"先发再修"。

## 四条上市标准与本仓库的保障方式

### 1. 稳定性与安全性

**自动化保障**
- 类型检查（tsc）+ ESLint 零错误零警告，单测覆盖：批处理协议容错、语言误判、遮罩还原、配置迁移、缓存损坏、备份导入净化、图片分段解析钳制。
- 浏览器回归 79 条：翻译管线、划词/悬停/输入框、面板、图片翻译、失败卡、暗色主题、吸顶导航，全部跑真实构建产物。
- 安全不变量（代码审计已确认，改这些区域时必须保持）：
  - API Key 只存 `storage.local`（按服务商隔离），只随请求发往用户配置的服务商端点；错误信息不回显 Key（`cleanSecret` 清洗 + `errorMessage` 只透 message）。
  - 全仓库无 `eval` / `new Function` / 远程脚本；CSP 收紧为 `script-src 'self'`。
  - 译文一律 `textContent` 注入（Shadow DOM 隔离），所有 `innerHTML` 均为静态模板。
  - 页面文本进 LLM 前有注入防护（`INJECTION_GUARD`）；图片 OCR prompt 同样带防注入声明。
  - 图片 URL：协议白名单（`data:image/`）+ 6MB 上限；IndexedDB 任务 24h TTL + 手动清理。
  - 设置导入经 `sanitizeImportedConfig` 白名单净化；术语学习输入剥除换行与全部分隔符。
  - `data_collection_permissions`（Firefox）与 PRIVACY.md、Chrome 商店隐私问卷口径一致。

**人工动作（每次发版）**
- 真机开 3 个重型网站（如 apple.com、news 站、SPA 后台）各做一次整页翻译 + 图片翻译，肉眼确认无叠印、无竖排乱码、无布局破坏。
- 用零配置新 profile 走一遍首启：装上 → 免 Key 直接翻译 → 设置引导 → 填 Key。

### 2. 运行体验（流畅）

**已有机制**
- 长页扫描分批让路主线程（`scanTextBlocksIncrementally` batch 12 / nodeBudget 240）；懒加载并发 2；MutationObserver 过滤自身 UI + 80ms 防抖 + 单批 >24 root 退回全量。
- 视口外内容 IntersectionObserver 懒翻译（rootMargin 320px）。
- 译文节点 Shadow DOM + `all:initial`，不影响宿主样式；几何校验失败自动降级放置策略。

**人工动作**
- 发版前在 DevTools Performance 面板录一次重型页面整页翻译，确认无长任务阻塞输入（>200ms 的任务应主要来自网络等待而非脚本计算）。

### 3. 翻译质量

**已有机制（自动化）**
- 质量自检 `auditTranslation`：数字/URL/代码 token 保真校验 + 幻觉英文碎片检测（CJK 译文中出现原文不存在的长英文词干 → ⚠ 警示）。
- 批量协议失败自动拆半/逐条降级；单条失败保留原文 + 失败卡重试，失败结果永不写入缓存。
- 放置策略几何校验（叠印检测、跨列检测、裁剪检测），排版事故由 `tiny-anchor-regression` 等夹具锁定。

**诚实声明**
- 译文准确性最终取决于用户所选模型。扩展的职责是：把上下文/术语/质量防线做满，把坏结果显性化（⚠ 角标 + 失败卡），把重试成本降到最低。**不要在发版说明里承诺"翻译 100% 准确"。**

**人工动作**
- 用自己配的引擎重测 2-3 个典型页面（资讯 / 电商 / 文档），抽读 10 段译文。

### 4. 成本优化（Token）

**已有机制（默认全开）**
- 目标语种本地跳过（0 Token）；批次内归一化去重（"Read more"/"read more." 只翻一次）；整段缓存 30 天 + 句子级缓存（只重译变化的句子）；术语库整条命中 0 Token；长文强模型路由阈值（1200 字符以下不用贵模型）；月度 Token 预算 + 80% 告警（含图片翻译用量）。
- 图片翻译：OCR 定位与文本翻译分离，文本复用上述全部省钱管线。

**人工动作**
- 设置页确认「本月已用」统计在增长且预算告警可触发（临时把预算调到 1 验证）。

## 发版流程

1. `npm run release` —— 全绿才继续。
2. 按「人工动作」清单过一遍真机。
3. 更新 CHANGELOG.md（顶部新条目）+ 同步版本号五处（`node scripts/check-version.mjs` 会拦不一致）。
4. 打 tag → GitHub Release（附 `.output/*-chrome.zip` 与说明）→ Chrome Web Store 上传 zip、填隐私问卷 → Firefox AMO 上传 zip + sources zip。
5. 商店文案用 README 的描述口径，不承诺测试未覆盖的能力。

## 已知边界（发版说明里应如实告知用户）

- 免 Key 通道（MyMemory/Apertium）无 SLA，长句质量与稳定性不如自配模型，适合体验不适合重度使用。
- 译文质量随所选模型浮动；扩展提供质量警示与重试，不承诺无误。
- 部分站点（银行/网银类）默认建议用户手动加入「从不翻译」名单。
