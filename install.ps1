$baseDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$geminiDir = "C:\Users\MoseeVision\.gemini"
New-Item -ItemType Directory -Path "$geminiDir\config\codex-bridge" -Force | Out-Null
New-Item -ItemType Directory -Path "$geminiDir\config\skills\codex-delegate" -Force | Out-Null
New-Item -ItemType Directory -Path "$geminiDir\antigravity\mcp\codex" -Force | Out-Null
New-Item -ItemType Directory -Path "$geminiDir\antigravity-cli\mcp\codex" -Force | Out-Null

Copy-Item "$baseDir\config\codex_bridge.mjs" "$geminiDir\config\codex-bridge\" -Force
Copy-Item "$baseDir\skills\codex-delegate\SKILL.md" "$geminiDir\config\skills\codex-delegate\" -Force
Copy-Item "$baseDir\mcp\codex\*.json" "$geminiDir\antigravity\mcp\codex\" -Force
Copy-Item "$baseDir\mcp\codex\*.json" "$geminiDir\antigravity-cli\mcp\codex\" -Force

Write-Host "codex-delegate installed successfully!" -ForegroundColor Green
