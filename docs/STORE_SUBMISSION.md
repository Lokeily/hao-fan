# 商店上架指南（Chrome Web Store / Edge Add-ons / Firefox AMO）

本文档是「好翻」在三个扩展商店上架的完整检查清单与操作步骤。上架后用户可获得**自动更新**，不再需要手动覆盖安装。

## 0. 上架前准备

1. 在 `package.json` 确认版本号，运行一次完整发布流程：

   ```bash
   npm run check:version && npm run lint && npm test && npm run typecheck && npm run build
   ```

2. 生成发布包：

   ```bash
   npm run zip        # Chrome / Edge：.output/open-translator-cn-*-chrome.zip
   npm run zip:firefox
   ```

3. 准备隐私政策 URL：本仓库 `PRIVACY.md` 已提供文案，需要托管到可公开访问的地址（GitHub Pages 或任意静态页，也可用 [Gist](https://gist.github.com) 托管后作为 URL）。

## 1. Chrome Web Store（CWS）

地址：https://chrome.google.com/webstore/devconsole

| 项目 | 要求 | 本项目的值 |
| --- | --- | --- |
| 开发者账号 | 一次性注册费 5 USD | — |
| ZIP | 上传 `-chrome.zip` | ✓ |
| 名称 | ≤ 45 字符 | 好翻 · Open Translator CN |
| 描述 | ≤ 132 字符，简明说明功能 | 见 README 简介 |
| 图标 | 128×128 PNG（manifest 已引用 `public/icon-128.png`） | ✓ |
| 截图 | 至少 1 张，建议 1280×800 或 640×400 | 需补充（页面截图） |
| 隐私政策 URL | 必填 | 托管 PRIVACY.md 后填入 |
| 权限声明 | 逐项说明用途 | 见 PRIVACY.md「权限说明」 |
| 发布方式 | 「公开」后进入审核，通常 1–5 个工作日 | — |

审核要点：

- 明确说明「用户自备 API Key，数据直连所选服务商」——CWS 对中转/代理类扩展敏感；
- `<all_urls>` 权限需在权限说明中解释清楚（本扩展用于任意网页内嵌翻译）；
- 不要在上架描述中承诺「免费无限额度」（AI 服务由第三方计费）。

## 2. Microsoft Edge Add-ons

地址：https://partner.microsoft.com/dashboard/microsoftedge

| 项目 | 要求 | 本项目的值 |
| --- | --- | --- |
| 开发者账号 | 免费（Microsoft 账号） | — |
| ZIP | 上传 `-chrome.zip`（Edge 兼容 Chromium MV3） | ✓ |
| 名称/描述 | 与 CWS 相同即可 | 复用 CWS 文案 |
| 图标 | 128×128 PNG | ✓ |
| 截图 | 至少 1 张 | 复用 CWS |
| 隐私政策 URL | 必填 | 复用 PRIVACY.md |

要点：Edge 商店允许「从 Chrome Web Store 同步列表」，可在开发者后台选择同步以减少维护成本。

## 3. Firefox AMO（addons.mozilla.org）

地址：https://addons.mozilla.org/developers/

| 项目 | 要求 | 本项目的值 |
| --- | --- | --- |
| 开发者账号 | 免费 | — |
| ZIP | 上传 `-firefox.zip` | ✓ |
| 自托管代码签名 | AMO 会为上传的扩展自动签名 | ✓ |
| 源码审核 | AMO 审核可要求源码：上传 `-sources.zip`（CI 已生成） | ✓ |
| Firefox 数据收集声明 | `data_collection_permissions` 已在 manifest 声明（authenticationInfo / websiteContent） | ✓ |
| 隐私政策 URL | 建议提供 | 复用 PRIVACY.md |

审核要点：

- AMO 要求扩展遵守 [Firefox 附加组件政策](https://extensionworkshop.com/documentation/publish/add-on-policies/)；
- 本项目 Firefox 版为 MV2，AMO 对 MV2 新提交的政策以官方最新公告为准（若要求迁移 MV3，需评估 Firefox 的 MV3 支持状态）；
- 「临时载入」的调试模式仅限开发，正式分发必须走 AMO 签名。

## 4. 上架后的日常

- 每次发版：本地 `npm run zip` 上传新包，或配置 CI 的 `release` job 后手动下载 `-chrome.zip` / `-firefox.zip`；
- 版本号变更会触发各商店的重新审核；
- 商店用户反馈与 GitHub Issues 建议同步维护。

## 5. 待办清单

- [ ] 补充商店截图（popup、设置页、整页翻译效果，浅色/深色各一张）
- [ ] 托管 PRIVACY.md 为公开 URL
- [ ] 注册 Chrome Web Store 开发者账号（5 USD）
- [ ] 注册 Edge / AMO 开发者账号（免费）
- [ ] 上传各商店并提交审核
