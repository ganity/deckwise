# A 主 Chat 普通/导入复验，2026-10-22

当前 A worktree 的源码 Electron、实际 WiseOffice 和 Host 使用修复后普通生成 PPTX（SHA-256 `c3aeaeb94308615b2af2529db1cdbd76f85b18fd14714e5ebd10adb9ccad37f3`）重跑直接打开与文件选择器导入两种路径。两次均通过 10 项检查：主 Chat 原生编辑、保存与完整重启、逐页讲解候选、人工确认采用、取消保护、跨 Chat 隔离，以及含等待动作的 PPTX 修改和重启恢复。

直接打开生成稿的记录见 [plain-report.json](plain-report.json) 和 [plain-chat-review.json](plain-chat-review.json)。该脚本未显式设置 `DECKWISE_E2E_TASK_TYPE=plain`，实际 review 中记录为默认 `taskType=import`，所以这份证据不能算普通生成任务验收。另一条路径经实际文件选择器复制 PPTX 到项目导入目录，逐字节校验副本后以 `taskType=import` 打开；记录见 [import-report.json](import-report.json) 和 [import-chat-review.json](import-chat-review.json)。普通任务的明确绑定证据仍以 [此前 plain 路径记录](../tts-confirmed-entry-20261022/main-chat-plain-20261022.md) 为准。

本次使用本地确定性 SSE 模型与测试身份，无 TTS 提交或费用。它复验了两条入口的 Chat/Office 路径，不是同一项目的真实平台配音、固定快照有声播放验收；普通生成也仍是经人工工程修复的样本，不证明 unattended PPT Master 可靠性。
