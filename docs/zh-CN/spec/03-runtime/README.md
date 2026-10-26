# 运行时核心

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/README) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


| 文档 | 描述 |
|---|---|
| [01-ipc-protocol.md](/zh-CN/spec/03-runtime/01-ipc-protocol) | Electron IPC 协议 |
| [02-agent-runtime.md](/zh-CN/spec/03-runtime/02-agent-runtime) | pi 代理运行时 |
| [03-工具和权限.md](/zh-CN/spec/03-runtime/03-tools-and-permissions) | 工具和权限 |
| [04-数据存储.md](/zh-CN/spec/03-runtime/04-data-storage) | 本地存储模型 |
| [05-host-core-rust.md](/zh-CN/spec/03-runtime/05-host-core-rust) | Rust 主机核心 |
| [06-host-rpc-protocol.md](/zh-CN/spec/03-runtime/06-host-rpc-protocol) | 主机 JSON-RPC 协议 |
| [07-process-model.md](/zh-CN/spec/03-runtime/07-process-model) | 流程拓扑和生命周期 |
| [08-错误代码.md](/zh-CN/spec/03-runtime/08-error-codes) | 共享错误代码注册表 |
| [09-logging-and-observability.md](/zh-CN/spec/03-runtime/09-logging-and-observability) | 日志记录和审计 |
| [10-会话状态机.md](/zh-CN/spec/03-runtime/10-session-state-machine) | Session/turn 状态机 |
| [11-provider-model-system.md](/zh-CN/spec/03-runtime/11-provider-model-system) | 通用提供商和模型覆盖范围 |
| [12-provider-config-schema.md](/zh-CN/spec/03-runtime/12-provider-config-schema) | 提供程序配置/SQL/主机方法 |
| [13-model-catalog-and-selection.md](/zh-CN/spec/03-runtime/13-model-catalog-and-selection) | 模型目录、选择器、选择 |
| [14-秘密-存储.md](/zh-CN/spec/03-runtime/14-secrets-storage) | 密钥存储和编辑 |
| [15-workspace-ignore-rules.md](/zh-CN/spec/03-runtime/15-workspace-ignore-rules) | 工作区忽略和拒绝名单 |
| [16-tool-result-limits.md](/zh-CN/spec/03-runtime/16-tool-result-limits) | 工具结果大小限制 |
| [17-asktool-questions.md](/zh-CN/spec/03-runtime/17-asktool-questions) | 交互式多问题工具 |
| [18-line-anchored-edit-contract.md](/zh-CN/spec/03-runtime/18-line-anchored-edit-contract) | 按行锚定的 Edit 合约 |
| [19-remote-agent-control-protocol.md](/zh-CN/spec/03-runtime/19-remote-agent-control-protocol) | 远程 Agent 控制协议 |
| [20-speech.md](/zh-CN/spec/03-runtime/20-speech) | 宿主语音（转写/朗读） |
| [21-courseware-parser.md](/zh-CN/spec/03-runtime/21-courseware-parser) | Optional local PPTX worker lifecycle |
| [22-courseware-contract-v1.md](/zh-CN/spec/03-runtime/22-courseware-contract-v1) | Courseware project/teaching contract and session-scoped Host persistence |
| [23-courseware-native-chat.md](/zh-CN/spec/03-runtime/23-courseware-native-chat) | Existing Chat native Office tools, ownership and Host permission dispatch |
| [24-courseware-narration-candidates.md](/zh-CN/spec/03-runtime/24-courseware-narration-candidates) | Internal Host narration proposal storage, review lifecycle and atomic adoption |
| [25-courseware-source-candidates.md](/zh-CN/spec/03-runtime/25-courseware-source-candidates) | Internal Host PPTX baseline/output archives, generator mapping context and restart recovery |
| [26-courseware-fixed-snapshots.md](/zh-CN/spec/03-runtime/26-courseware-fixed-snapshots) | Explicit per-page teaching confirmation and Host-owned immutable source/teaching/mapping/audio exports |
| [27-courseware-authorized-media.md](/zh-CN/spec/03-runtime/27-courseware-authorized-media) | Main-only authenticated TTS transport; Host ingestion remains pending |
| [29-courseware-chat-workflow.md](/zh-CN/spec/03-runtime/29-courseware-chat-workflow) | Main Chat generation, finite tools, human approvals and teaching requirements CAS |
