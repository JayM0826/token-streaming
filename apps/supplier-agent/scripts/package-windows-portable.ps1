$ErrorActionPreference = "Stop"

$packageRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $packageRoot "..\.."))
$manifest = Get-Content -LiteralPath (Join-Path $packageRoot "package.json") -Raw | ConvertFrom-Json
$outputRoot = [System.IO.Path]::GetFullPath((Join-Path $packageRoot "outputs"))
$target = [System.IO.Path]::GetFullPath((Join-Path $outputRoot "portable-windows-x64-v$($manifest.version)"))
$archive = [System.IO.Path]::GetFullPath((Join-Path $outputRoot "GongSuanYun-Supplier-Agent-windows-x64-v$($manifest.version).zip"))

if (-not $target.StartsWith($outputRoot, [System.StringComparison]::OrdinalIgnoreCase) -or -not $archive.StartsWith($outputRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Portable package path escaped the Supplier Agent outputs directory."
}
if (Test-Path -LiteralPath $target) { throw "Portable target already exists: $target" }
if (Test-Path -LiteralPath $archive) { throw "Portable archive already exists: $archive" }

Push-Location $workspaceRoot
try {
  corepack pnpm@9.15.0 --filter @token-streaming/supplier-agent deploy --prod $target
  if ($LASTEXITCODE -ne 0) { throw "pnpm deploy failed." }
} finally {
  Pop-Location
}

$runtime = Join-Path $target "runtime"
New-Item -ItemType Directory -Path $runtime | Out-Null
$node = (Get-Command node -ErrorAction Stop).Source
Copy-Item -LiteralPath $node -Destination (Join-Path $runtime "node.exe")
Copy-Item -LiteralPath (Join-Path $packageRoot "portable\start-agent.cmd") -Destination $target
Copy-Item -LiteralPath (Join-Path $packageRoot "portable\doctor.cmd") -Destination $target
Copy-Item -LiteralPath (Join-Path $packageRoot "portable\README-zh-CN.txt") -Destination $target
Compress-Archive -LiteralPath $target -DestinationPath $archive -CompressionLevel Optimal
Write-Output $archive
