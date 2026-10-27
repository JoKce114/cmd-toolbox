$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'native\ConInputHelper.cs'
$output = Join-Path $root 'build\coninject.exe'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path $csc)) { throw "找不到 .NET Framework 编译器：$csc" }
if (-not (Test-Path $source)) { throw "找不到源文件：$source" }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $output) | Out-Null

& $csc /nologo /target:winexe /optimize+ /out:$output $source
if ($LASTEXITCODE -ne 0) { throw "编译失败：$LASTEXITCODE" }
Write-Host "已生成 $output"
