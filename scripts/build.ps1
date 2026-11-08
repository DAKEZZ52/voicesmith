#requires -Version 5.1
<#
    一键构建：整理 payload -> 压缩成 payload.7z -> 打 NSIS 安装包
    产物：
      release\GPT-SoVITS-Setup-<ver>.exe   安装程序（约 150 MB）
      release\payload.7z                   运行时包（约 3.8 GB）
#>
param(
    [switch]$SkipPayload,   # 复用已存在的 payload.7z
    [switch]$SkipInstaller
)

$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $PSScriptRoot
$src = 'E:\01-项目开发\GPT-SoVITS'
$stage = 'E:\01-项目开发\payload-stage'
$sevenZip = Join-Path $proj 'node_modules\7zip-bin\win\x64\7za.exe'
$archive = Join-Path $proj 'release\payload.7z'

if (-not (Test-Path $sevenZip)) { throw "找不到 7za.exe，请先 npm install" }

if (-not $SkipPayload) {
    Write-Host "[1/3] 整理 payload …"
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    robocopy $src $stage /E /NFL /NDL /NJH /NJS /NP `
        /XD '.git' '.github' '.setup' '.downloads' 'logs' 'output' 'TEMP' '__pycache__' `
           'pretrained_models' 'G2PWModel' 'uvr5_weights' 'nltk_data' 'open_jtalk_dic_utf_8-1.11' 'docs' `
        /XF '*.pyc' '*.log' | Out-Null

    $junk = @('Docker','docker-compose.yaml','Dockerfile','docker_build.sh','install.sh','install.ps1',
        'requirements-py312-win-flash_attention','weight.json','_local_setup.md','.pre-commit-config.yaml',
        '.dockerignore','启动GPT-SoVITS.exe','test_api_v2_streaming.py','test_official_streaming.py',
        'Colab-Inference.ipynb','Colab-WebUI.ipynb')
    foreach ($j in $junk) { Remove-Item (Join-Path $stage $j) -Recurse -Force -ErrorAction SilentlyContinue }

    $size = (Get-ChildItem $stage -Recurse -File | Measure-Object Length -Sum).Sum / 1GB
    Write-Host ("      payload {0:N2} GB" -f $size)

    Write-Host "[2/3] 压缩 payload.7z（约 8~10 分钟）…"
    New-Item -ItemType Directory -Force (Split-Path $archive) | Out-Null
    if (Test-Path $archive) { Remove-Item $archive -Force }
    Push-Location $stage
    & $sevenZip a -t7z -mx=5 -mmt=on $archive '.' | Out-Null
    Pop-Location
    Write-Host ("      payload.7z {0:N2} GB" -f ((Get-Item $archive).Length / 1GB))
}

if (-not $SkipInstaller) {
    Write-Host "[3/3] 打安装包 …"
    Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    Push-Location $proj
    npm run dist
    Pop-Location
}

Get-ChildItem (Join-Path $proj 'release') -Filter '*.exe' | Select-Object Name, @{n='MB'; e={[math]::Round($_.Length/1MB,1)}}
Write-Host '完成：把 GPT-SoVITS-Setup-*.exe 和 payload.7z 放在同一目录发给用户。'
