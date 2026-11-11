#requires -Version 5.1
<#
    上传监督：反复检查 Release 资产，缺哪个传哪个，失败自动重试，直到全部到位。
    用法: powershell -File scripts/upload-all.ps1 -Token <tok> [-MaxPasses 40]
    日志: release/upload.log
#>
param(
    [Parameter(Mandatory = $true)][string]$Token,
    [string]$Owner = 'DAKEZZ52',
    [string]$Repo = 'weavevoice',
    [string]$ReleaseId = '438369117',
    [int]$MaxPasses = 40
)

$ErrorActionPreference = 'Continue'
$proj = Split-Path -Parent $PSScriptRoot
$log = Join-Path $proj 'release\upload.log'

function Say($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
    Write-Host $line
    Add-Content -Path $log -Value $line -Encoding utf8
}

$headers = @{ Authorization = "Bearer $Token"; 'User-Agent' = 'weavevoice'; Accept = 'application/vnd.github+json' }
$parts = @('payload.7z.001', 'payload.7z.002', 'payload.7z.003', 'payload.7z.004')

Say "监督开始：目标 Release $ReleaseId，分卷数 $($parts.Count)"

for ($pass = 1; $pass -le $MaxPasses; $pass++) {
    $assets = @()
    try {
        $assets = (Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases/$ReleaseId" -Headers $headers -TimeoutSec 60).assets
    } catch {
        Say "查询资产失败：$($_.Exception.Message)，10 秒后重试"
        Start-Sleep 10
        continue
    }

    $missing = @()
    foreach ($p in $parts) {
        $a = $assets | Where-Object { $_.name -eq $p }
        if (-not $a -or $a.state -ne 'uploaded') { $missing += $p }
    }
    if ($missing.Count -eq 0) {
        Say "全部分卷已上传，开始校验字节数…"
        $ok = $true
        foreach ($p in $parts) {
            $a = $assets | Where-Object { $_.name -eq $p }
            $local = (Get-Item (Join-Path $proj "release\$p")).Length
            if ($a.size -ne $local) { Say "大小不一致 $p ：远端 $($a.size) / 本地 $local"; $ok = $false }
        }
        if ($ok) { Say "校验通过，监督结束"; exit 0 }
        Say "校验失败，继续下一轮"
        Start-Sleep 15
        continue
    }

    Say "第 $pass 轮：缺 $($missing -join ', ')"
    foreach ($p in $missing) {
        $file = Join-Path $proj "release\$p"
        if (-not (Test-Path $file)) { Say "本地缺文件 $p，跳过"; continue }
        Say "开始上传 $p …"
        $out = & node (Join-Path $proj 'scripts\upload-asset.js') $Owner $Repo $ReleaseId $Token $file 2>&1
        $out | ForEach-Object { Say "  $_" }
        Start-Sleep 5
    }
}

Say "达到最大轮次仍未完成"
exit 1
