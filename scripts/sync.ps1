# 把本仓库的改动提交并推送到 GitHub（origin）。
# 用法：
#   pwsh -File scripts/sync.ps1                       # 自动生成提交信息
#   pwsh -File scripts/sync.ps1 -Message "feat: xxx"  # 指定 Conventional Commits 信息
param(
    [string]$Message = ''
)

$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    git add -A
    if (git diff --cached --quiet) {
        Write-Output '没有需要提交的改动。'
        return
    }
    if (-not $Message) {
        $changed = git diff --cached --name-only
        $Message = "chore: sync $([datetime]::Now.ToString('yyyy-MM-dd HH:mm'))"
        Write-Output "未指定 -Message，使用：$Message"
    }
    git commit -m $Message
    git push
    Write-Output '已推送。'
}
finally {
    Pop-Location
}