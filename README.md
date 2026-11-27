# codex-delegate

Antigravity to OpenAI Codex App Server bridge with 2-concurrency process pool, thread affinity (KV cache persistence), and read-only delegation.

## Features
- **Process Pool Concurrency**: Strictly limited to 2 concurrent tasks.
- **Thread Affinity**: Routes follow-up turns to the matching process instance for KV cache reuse.
- **Read-Only Safety**: Defaults to read-only workspace mode.
- **Slice Window & Wait**: Automatically hands off long-running operations via `codex_wait`.
- **Default Tier**: Standard tier by default to conserve quota.

## Repository Contents
- `config/codex_bridge.mjs`: Bridge server implementing MCP and Codex App Server client pool.
- `skills/codex-delegate/SKILL.md`: Antigravity skill instructions for delegation workflows.
- `mcp/codex/`: Tool definitions (`codex_explore`, `codex_resume`, `codex_review`, `codex_wait`).
- `install.ps1`: One-click setup script for Windows.

## Installation
Run the installer script in PowerShell:
```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```
