$ErrorActionPreference = "Stop"
$root = Join-Path $PSScriptRoot "..\references"
New-Item -ItemType Directory -Force -Path $root | Out-Null

$repos = @(
  @{ Name = "better-agent-terminal"; Url = "https://github.com/tony1223/better-agent-terminal.git" },
  @{ Name = "hermes"; Url = "https://github.com/pantheonforge/hermes.git" },
  @{ Name = "langgraph"; Url = "https://github.com/langchain-ai/langgraph.git" },
  @{ Name = "openai-agents-python"; Url = "https://github.com/openai/openai-agents-python.git" },
  @{ Name = "codex"; Url = "https://github.com/openai/codex.git" },
  @{ Name = "claude-agent-sdk-demos"; Url = "https://github.com/anthropics/claude-agent-sdk-demos.git" },
  @{ Name = "microsoft-agent-framework"; Url = "https://github.com/microsoft/agent-framework.git" }
)

foreach ($repo in $repos) {
  $dest = Join-Path $root $repo.Name
  if (Test-Path $dest) {
    Write-Host "[skip] $($repo.Name) already exists"
  } else {
    Write-Host "[clone] $($repo.Url)"
    git clone --depth 1 $repo.Url $dest
  }
}
