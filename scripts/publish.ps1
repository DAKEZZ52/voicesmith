#requires -Version 5.1
<#
    一键发布：建仓（若不存在）→ 推送代码 → 建 Release → 上传资产
    用法：
      pwsh -File scripts/publish.ps1 -Token 'github_pat_xxx'
    可选：
      -Tag v1.0.0  -SkipPush  -SkipUpload
#>
param(
    [Parameter(Mandatory = $true)][string]$Token,
    [string]$Owner = 'DAKEZZ52',
    [string]$Repo = 'weavevoice',
    [string]$Tag = 'v1.0.0',
    [switch]$SkipPush,
    [switch]$SkipUpload
)

$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $PSScriptRoot
$headers = @{
    Authorization          = "Bearer $Token"
    'User-Agent'           = 'weavevoice-release'
    Accept                 = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
}

function Api($method, $path, $bodyObj) {
    $uri = if ($path -like 'http*') { $path } else { "https://api.github.com$path" }
    $params = @{ Method = $method; Uri = $uri; Headers = $headers; TimeoutSec = 60 }
    if ($bodyObj) {
        $params.Body = [System.Text.Encoding]::UTF8.GetBytes(($bodyObj | ConvertTo-Json -Depth 6))
        $params.ContentType = 'application/json; charset=utf-8'
    }
    return Invoke-RestMethod @params
}

Write-Host "[1/4] 检查仓库 $Owner/$Repo …"
$exists = $true
try { $null = Api GET "/repos/$Owner/$Repo" } catch { $exists = $false }

if (-not $exists) {
    Write-Host "      不存在，创建中…"
    $body = @{
        name        = $Repo
        description = '织声 WeaveVoice —— 本地 AI 语音合成与音色微调桌面端（Windows）'
        private     = $false
        has_issues  = $true
        has_wiki    = $false
    }
    try {
        $created = Api POST '/user/repos' $body
        Write-Host "      已创建：$($created.html_url)"
    } catch {
        Write-Host "      创建失败：$($_.Exception.Message)" -ForegroundColor Red
        Write-Host "      说明：Fine-grained token 需要 Administration(Read and write) + All repositories" -ForegroundColor Yellow
        throw
    }
} else {
    Write-Host "      已存在，跳过创建"
}

if (-not $SkipPush) {
    Write-Host "[2/4] 推送代码 …"
    Push-Location $proj
    if (git remote) { git remote remove origin }
    git remote add origin "git@github.com:$Owner/$Repo.git"
    git push -u origin main 2>&1 | ForEach-Object { "      $_" }
    Pop-Location
}

Write-Host "[3/4] 建 Release $Tag …"
$release = $null
try {
    $release = Api GET "/repos/$Owner/$Repo/releases/tags/$Tag"
    Write-Host "      已存在 release id=$($release.id)"
} catch {
    $body = @{
        tag_name         = $Tag
        target_commitish = 'main'
        name             = "织声 WeaveVoice $Tag"
        body             = "## 织声 WeaveVoice $Tag`n`n本地 AI 语音合成与音色微调桌面端。`n`n### 安装`n`n1. 下载 ``WeaveVoice-Setup-$($Tag.TrimStart('v')).exe`` 与 ``payload.7z.001``、``payload.7z.002``，三个文件放同一目录`n2. 双击安装，首次启动自动拼合解压运行环境（约 8.6 GB）`n3. 首次启动会下载约 5.3 GB 预训练模型（ModelScope 国内源）`n`n### 系统要求`n`nWindows 10/11 x64 · NVIDIA 显卡（CUDA 12 驱动）· ≥6 GB 显存 · 约 15 GB 磁盘`n`n语音引擎基于 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)（MIT）。"
        draft            = $false
        prerelease       = $false
    }
    $release = Api POST "/repos/$Owner/$Repo/releases" $body
    Write-Host "      已创建：$($release.html_url)"
}

if (-not $SkipUpload) {
    Write-Host "[4/4] 上传资产（可能耗时较久）…"
    $assets = @(
        "release\WeaveVoice-Setup-1.0.0.exe",
        "release\latest.yml",
        "release\payload.7z.001",
        "release\payload.7z.002"
    )
    foreach ($rel in $assets) {
        $file = Join-Path $proj $rel
        if (-not (Test-Path $file)) { Write-Host "      跳过（不存在）：$rel"; continue }
        $name = Split-Path $file -Leaf
        $sizeGB = (Get-Item $file).Length / 1GB
        Write-Host ("      上传 {0} ({1:N2} GB) …" -f $name, $sizeGB)

        $existing = @()
        try { $existing = (Api GET "/repos/$Owner/$Repo/releases/$($release.id)/assets").assets } catch {}
        if ($existing -and ($existing | Where-Object { $_.name -eq $name })) {
            Write-Host "        已存在，跳过"
            continue
        }

        $uri = "https://uploads.github.com/repos/$Owner/$Repo/releases/$($release.id)/assets?name=$([uri]::EscapeDataString($name))"
        $out = & curl.exe -sS --max-time 7200 -X POST $uri `
            -H "Authorization: Bearer $Token" `
            -H "X-GitHub-Api-Version: 2022-11-28" `
            -H "Content-Type: application/octet-stream" `
            --data-binary "@$file" -w "`nHTTP=%{http_code}" 2>&1
        $code = ($out | Select-String 'HTTP=(\d+)').Matches.Groups[1].Value
        if ($code -eq '201') { Write-Host "        完成" -ForegroundColor Green }
        else { Write-Host "        失败 HTTP=$code $($out | Select-Object -Last 2)" -ForegroundColor Red }
    }
}

Write-Host ""
Write-Host "仓库：https://github.com/$Owner/$Repo"
Write-Host "Release：https://github.com/$Owner/$Repo/releases/tag/$Tag"
