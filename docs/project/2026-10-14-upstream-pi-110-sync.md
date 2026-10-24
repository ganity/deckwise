# DeckWise 上游选择性合并与 Pi 1.1.0 迁移

本次合并基于 DeckWise `0b1dacf6b`，选择性吸收 [PI-Desktop `4f6890ecd`](https://github.com/vastsa/PI-Desktop/commit/4f6890ecd4fd75683168333d433d93720fe9a215)。共同祖先为 `5f0f38d76`。任务分支为 `chore/upstream-pi-110-sync`；已刷新远端，`origin/main` 为 `58a9c4f57`，且已包含在任务基线中。

## 合并范围

| 范围 | 结果 |
| --- | --- |
| Pi 依赖及补丁 | `pi-ai`、`pi-agent-core`、`pi-coding-agent` 从 0.85.1 统一到 1.1.0；接入同版本 MCP，迁移三个补丁并新增依赖、补丁一致性检查。 |
| Agent Runtime | 移植上下文预算与压缩、流恢复、usage、代理及证书处理、工具调用去重、附件恢复、原生搜索等兼容更新；将 Pi 已移除的旧 harness 接口迁移到运行时内部适配。 |
| Host | 移植会话、转录持久化、工具安全、计划、定时任务、技能包、插件校验及 worktree/config-sync 等服务端更新。新增能力保留在 Host/shared 层，未移植新版桌面入口。 |
| 插件协议 | 同步 SDK、devkit、网络权限及 renderer 合约，同时保留 fork 的插件设置页面声明和路径校验。 |
| 打包 | Sidecar 改为原子暂存、分块 ESM，并打包图片处理 worker/WASM；保留 DeckWise Python、PPT Master、Office 资源及发行配置。 |
| Desktop | 保留现有界面，仅适配 ask 选项、thinking `omit`、usage、扩展请求取消和更新状态等接口变化。 |

保留 DeckWise 身份、扫码认证、课件导入及文档解析、PPTX 专用任务约束、Office 预览、提示增强、会话标题总结、`.deckwise` 工作目录、默认 `auto` 权限，以及插件市场自定义地址。结构化文档附件仍使用解析后的文本，历史恢复不会把 PDF/Office 二进制重新当作文本读取；413 错误仍单独分类。

未合入通用 Agent 界面重构、新语音产品、独立 pi-host、示例工程、上游发行版本及其整套文档。已知 `upstream/main` 的 `cd91b9969` 比选定提交多出的三个提交仅涉及新版界面的会话阅读位置及测试；本次未移植。

## 数据兼容

JSON-RPC 协议仍为 v11。SQLite 实际存储版本从 v18 升至 v24，使用上游逐级事务迁移与迁移前备份。旧 Host 不支持打开 v24 数据库；回退应用时需要恢复对应旧版数据库备份。本次只在临时测试数据目录验证，未迁移用户日常使用的数据目录。

## 验证

| 检查 | 结果 |
| --- | --- |
| 单元与合约测试 | Desktop 2153 通过、1 跳过；Runtime 1407；Shared 1256；SDK 383；Devkit 52；Agent Host 65，均通过。 |
| Rust 全量测试 | `cargo test -p host-core --locked`：932 通过、0 失败、1 忽略。 |
| 静态检查 | 全工作区 TypeScript、lint、Rust fmt、clippy、架构检查通过。clippy 保留上游一处 `filter_next` 提示；两项文件长度例外沿用上游说明。 |
| 依赖与构建 | 冻结锁文件离线安装、Pi 依赖与补丁审计、Electron 生产构建、实际 Sidecar bundle、Host 构建通过。 |
| Headless E2E | Smoke 22 通过、2 跳过；Plan/command-shell 13 通过、4 跳过。 |

E2E 使用临时数据库和插件市场离线回退。未配置真实模型 API key，因此跳过真实模型及流式调用；未运行交互式 GUI 验证和跨平台安装包构建。Plan 跳过项包括其他 shell、模拟已安装 shell 不可用及 60 秒长超时场景。

本次交付为本地任务分支合并提交，未推送或修改主工作区的 `main`；远端集成应按仓库 PR 门禁完成。
