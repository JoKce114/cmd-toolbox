$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$parent = Split-Path -Parent $root
$source = Join-Path $root 'native\Launcher.cs'
$built = Join-Path $root 'build\CmdToolbox.exe'
$desktop = Join-Path $parent 'CmdToolbox.exe'
$icon = Join-Path $root 'build\icon.ico'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path $csc)) { throw "找不到 .NET Framework 编译器：$csc" }
if (-not (Test-Path $source)) { throw "找不到源文件：$source" }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $built) | Out-Null

$temp = Join-Path $env:TEMP 'CmdToolboxLauncher.cs'
$utf8Bom = New-Object System.Text.UTF8Encoding $true
[System.IO.File]::WriteAllText($temp, [System.IO.File]::ReadAllText($source, [System.Text.UTF8Encoding]::new($false)), $utf8Bom)

$compilerArgs = @('/nologo', '/target:winexe', '/optimize+', "/out:$built", '/r:System.Windows.Forms.dll', $temp)
if (Test-Path $icon) {
	$compilerArgs = @('/nologo', '/target:winexe', '/optimize+', "/win32icon:$icon", "/out:$built", '/r:System.Windows.Forms.dll', $temp)
}

& $csc @compilerArgs
if ($LASTEXITCODE -ne 0) { throw "编译启动器失败：$LASTEXITCODE" }

try {
	Copy-Item -LiteralPath $built -Destination $desktop -Force
	Write-Host "已生成 $desktop"
} catch {
	$pending = Join-Path $parent 'CmdToolbox.new.exe'
	Copy-Item -LiteralPath $built -Destination $pending -Force
	Write-Host "桌面上的 CmdToolbox.exe 正在被占用，新启动器已放到 $pending"
	Write-Host "关掉正在运行的 Cmd Toolbox 后，把 CmdToolbox.new.exe 改名为 CmdToolbox.exe"
}
