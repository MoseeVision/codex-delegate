---
name: codex-delegate
description: >-
  Proactively delegate codebase exploration, cross-file call-chain tracing, and independent code reviews
  to the local OpenAI Codex app-server via global MCP tools (read-only, preserving 95%+ KV cache via thread_id).
  Activate whenever scanning unfamiliar modules, reading large files, auditing complex flows,
  or running a second-model review before finishing edits — prefer delegating over flooding the main context.
---

# Codex 代码调研与审核外包指南

本机已通过全局 MCP (`codex`) 接入官方 `codex app-server`，默认一律**只读模式 (`read-only`)**，并通过 `thread_id` 接力保留 95%+ 上下文与 KV 缓存。

## 外包原则（主动优先，不硬啃大文件）

- **翻代码优先外包 (`codex_explore`)**：只要涉及**批量翻阅陌生源码、追踪跨文件调用链、排查复杂模块边界或需要读取多处大文件**，**优先主动交给 Codex 执行**，把主对话上下文留给推理和决策（仅查看一两个已知行号的小片段时直接自查即可，不杀鸡用牛刀）。
- **改动后交叉审核 (`codex_review`)**：非简单改动完成后，主动交由 Codex 做独立只读 Code Review（查回归、边界遗漏与并发竞态）。
- **固定分工档位**：
  - 翻找代码（`codex_explore`）：固定传 `model: "gpt-6-luna"`、`effort: "xhigh"`、`serviceTier: "default"`。
  - 代码审核（`codex_review`）：固定传 `model: "gpt-6.2-sol"`、`effort: "medium"`、`serviceTier: "default"`。
- **只读与核验底线**：除非用户明确要求，否则始终保持只读（不让 Codex 改文件）；关键结论与具体符号行号交付前在本端做最小必要核验。

## 调用方式（全局 MCP 工具，严禁绕去终端敲命令）

1. **主动翻找代码 (`codex_explore`)**
   - 触发时机：面对陌生代码库、跨模块调用链、大型脚本或复杂状态流时，别在主会话里逐个大段读文件，**第一时间发起 `codex_explore`** 摸清全貌并定位精确文件/行号。
   - 参数：`prompt`（写明调研问题、关注目录/入口和期望返回的证据要点）、`cwd`（当前工作区绝对路径）、`model: "gpt-6-luna"`、`effort: "xhigh"`、`serviceTier: "default"`。
   - 记住返回的 `[codex thread_id: <uuid> | ...]`，后续追问必须复用。

2. **接力追问保缓存 (`codex_resume`)**
   - 触发时机：围绕同一任务继续深挖细节、验证边界或针对审核意见讨论对齐，**不要重开新会话**。
   - 参数：`thread_id`（传入上一轮 `thread_id`；或 `"last"`）、`prompt`、`cwd`，并保持与原会话一致的 `model` / `effort` / `serviceTier`（如审核复议保持 `gpt-6.2-sol` + `medium` + `default`）。

3. **独立代码审核 (`codex_review`)**
   - 触发时机：完成非简单功能或修复后，在交付前发起独立复核。
   - 参数：`target`（`uncommitted` / `branch` / `commit` / `custom`）、`cwd`、`model: "gpt-6.2-sol"`、`effort: "medium"`、`serviceTier: "default"`。
   - 闭环原则：对照本端审查与源码事实逐条核对，不盲从误报也不放过真问题；对 `P0/P1` 核心结论有异议时，带具体文件行号通过 `codex_resume` 复用原 `thread_id` 讨论对齐（最多 2 轮；仍不一致交由用户裁决）。

4. **超时分段接力 (`codex_wait`)**
   - 机制：桥接层总超时上限为 **30 分钟（1800s）**；单次 MCP 调用在 150s 未完成时会自动返回 `status: running` 与 `job_id`（任务继续在后台运行）。
   - 接力：看到 `status: running` 时，立即调用 `codex_wait(job_id)` 继续接力等待（每次最多 150s，直到完成或满 30 分钟）。
