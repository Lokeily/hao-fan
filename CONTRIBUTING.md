# 贡献指南

感谢你愿意帮助改进好翻。无论是报告问题、修正文档、补充测试还是提交代码，都属于有效贡献。

## 提交问题

提交 Bug 前请先搜索现有 Issues，避免重复报告。新问题建议包含：

- 浏览器名称和版本
- 好翻版本
- 问题页面或可公开访问的示例页面
- 可以重复执行的操作步骤
- 预期结果和实际结果
- 必要的截图或错误信息

请先隐藏截图和日志中的 API Key、账号、邮箱、Cookie 等敏感信息。

## 本地开发

需要安装 Node.js 22 和 npm。

~~~bash
git clone https://github.com/Lokeily/hao-fan.git
cd hao-fan
npm install
npm run dev
~~~

开发构建位于 `.output/chrome-mv3-dev`。打开 Chrome 扩展管理页，开启开发者模式，然后加载该目录。

## 修改代码

1. 从最新的 `main` 创建独立分支。
2. 一个分支只处理一个明确问题。
3. 保持修改范围小，并沿用现有代码风格。
4. 用户可见行为发生变化时，请补充测试或更新文档。
5. 不要提交 API Key、本地配置、日志、构建目录或个人数据。

提交前运行：

~~~bash
npm test
npm run typecheck
npm run build
npm run test:browser
npm run build:firefox
~~~

浏览器回归测试需要 Chrome；CI 会自动安装对应的 Chromium 测试运行时。

## 提交 Pull Request

Pull Request 说明应包含：

- 修改了什么
- 为什么需要修改
- 对用户有什么影响
- 如何验证修改
- 仍然存在的限制或风险

维护者可能会要求补充复现步骤、测试或调整实现。请围绕代码和可验证事实讨论。
