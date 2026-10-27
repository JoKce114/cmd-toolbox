param(
  [int]$Seconds = 6,
  [string]$Log = 'D:\project-demo\cmd-toolbox\.test-data\mouse-reader.log'
)
$ErrorActionPreference = 'Continue'
Add-Type -Path 'D:\project-demo\cmd-toolbox\tests\ConsoleMouseReader.cs'
[ConsoleMouseReader]::Listen($Seconds, $Log) | Out-Null
