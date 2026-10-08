#requires -Version 5.1
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root.

[CmdletBinding()]
param(
	[string]$PackageRoot = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($PackageRoot)) {
	$PackageRoot = Split-Path -Parent $PSScriptRoot
}

function Get-Base64Sha256 {
	param([Parameter(Mandatory = $true)][string]$Path)

	$stream = [IO.File]::OpenRead($Path)
	try {
		$sha256 = [Security.Cryptography.SHA256]::Create()
		try {
			return ([Convert]::ToBase64String($sha256.ComputeHash($stream))).TrimEnd('=')
		} finally {
			$sha256.Dispose()
		}
	} finally {
		$stream.Dispose()
	}
}

$packageFullPath = [IO.Path]::GetFullPath($PackageRoot)
$requiredFiles = @(
	'runtime-patches.mjs',
	'payload\bundles\main.js',
	'install-native-codex-inline-diff.bat',
	'README.md',
	'scripts\patch-official-vscode.ps1',
	'scripts\test-patch-official-vscode.ps1',
	'payload\product.json',
	'payload\bundles\vs\workbench\workbench.desktop.main.js',
	'payload\bundles\vs\workbench\workbench.desktop.main.css',
	'payload\bundles\vs\workbench\api\node\extensionHostProcess.js',
	'payload\bundles\vs\workbench\api\worker\extensionHostWorkerMain.js',
	'payload\bundles\vs\sessions\sessions.desktop.main.js'
)

foreach ($relativePath in $requiredFiles) {
	$path = Join-Path $packageFullPath $relativePath
	if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
		throw "Portable package file is missing: $relativePath"
	}
}

$batPath = Join-Path $packageFullPath 'install-native-codex-inline-diff.bat'
$batText = [IO.File]::ReadAllText($batPath)
if ($batText -match '(?i)[A-Z]:\\' -or $batText.Contains('..\vscode') -or $batText.Contains('VSCode-win32-x64')) {
	throw 'The portable BAT still contains a machine-specific or repository-relative path.'
}
if (-not $batText.Contains('set "PATCH_SCRIPT=%PACKAGE_DIR%scripts\patch-official-vscode.ps1"') -or
	-not $batText.Contains('set "PATCH_BUILD_DIR=%PACKAGE_DIR%payload"') -or
	-not $batText.Contains('-PatchBuildDir "%PATCH_BUILD_DIR%"')) {
	throw 'The portable BAT does not resolve its script and payload from its own directory.'
}
if (-not $batText.Contains('set "PSModulePath="')) {
	throw 'The portable BAT does not isolate Windows PowerShell from an inherited PowerShell 7 module path.'
}

$patchScriptPath = Join-Path $packageFullPath 'scripts\patch-official-vscode.ps1'
$patchScriptText = [IO.File]::ReadAllText($patchScriptPath)
if ($patchScriptText.Contains('VSCode-win32-x64') -or
	-not $patchScriptText.Contains("Join-Path `$PSScriptRoot '..\payload'")) {
	throw 'The patch script does not default to the packaged payload directory.'
}

$productPath = Join-Path $packageFullPath 'payload\product.json'
$product = Get-Content -LiteralPath $productPath -Raw | ConvertFrom-Json
if ($product.nativeReviewPatch.revision -ne '2026-09-16-review-fixes') {
	throw 'The native review fix revision is missing.'
}
$sourcePatch = Join-Path $packageFullPath 'source-changes.patch'
if ((Get-FileHash -LiteralPath $sourcePatch -Algorithm SHA256).Hash -ne $product.nativeReviewPatch.sourceDiffSha256) {
	throw 'The source changes do not match the payload provenance.'
}
if ((Get-FileHash -LiteralPath (Join-Path $packageFullPath 'runtime-patches.mjs') -Algorithm SHA256).Hash -ne $product.nativeReviewPatch.runtimePatchScriptSha256) {
	throw 'The runtime transformation does not match the payload provenance.'
}
if ($product.version -ne '1.141.0' -or $product.commit -ne '14c79d4bed33adba68885de4a1785143a824d311') {
	throw 'The payload metadata does not match the tested patch build.'
}

$expectedHashes = @{
	'main.js' = '__MAIN_BUNDLE_HASH__'
	'vs\workbench\workbench.desktop.main.js' = 'N+r2mJlf7IUR3WtjmTquJGqz62FVf8DLgk+9Nx9tvrg'
	'vs\workbench\workbench.desktop.main.css' = 'E8EPBzg71CfVy6b9dDS5GrUwZlEbksdDe5WOIhRSnqo'
	'vs\workbench\api\node\extensionHostProcess.js' = 'BmT31kS/ltMJC4wKLVuuUiG0rzwe+k5bwv4y464ZcDc'
	'vs\workbench\api\worker\extensionHostWorkerMain.js' = 'l7IZNgTZEWKhXtEQqddYjslhz3xFQx2AOTBqOLU9eqo'
	'vs\sessions\sessions.desktop.main.js' = '5xTLkctKnqnRAK5RLTM/K2z0h3driMkMc8EZnPDqosg'
}

foreach ($relativePath in $expectedHashes.Keys) {
	$bundlePath = Join-Path (Join-Path $packageFullPath 'payload\bundles') $relativePath
	$actualHash = Get-Base64Sha256 $bundlePath
	if ($actualHash -ne $expectedHashes[$relativePath]) {
		throw "Payload bundle hash mismatch: $relativePath"
	}
}

Write-Host "Portable package structure and payload hashes: PASS ($packageFullPath)"
