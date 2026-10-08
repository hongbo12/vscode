#requires -Version 5.1
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root.

[CmdletBinding()]
param(
	[string]$PatchScript = '',

	[string]$OfficialAppDir = '',

	[string]$OfficialInstallDir = '',

	[string]$PatchBuildDir = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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

function Resolve-OfficialAppDir {
	$installCandidates = if ($OfficialInstallDir) { @($OfficialInstallDir) } else { @(
		(Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\Microsoft VS Code'),
		(Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Microsoft VS Code'),
		(Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft VS Code')
	) | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -Unique }

	$matches = @()
	foreach ($installDir in $installCandidates) {
		$appCandidates = @((Join-Path $installDir 'resources\app'))
		foreach ($directory in Get-ChildItem -LiteralPath $installDir -Directory -ErrorAction SilentlyContinue) {
			$appCandidates += Join-Path $directory.FullName 'resources\app'
		}

		foreach ($appDir in @($appCandidates | Select-Object -Unique)) {
			$productPath = Join-Path $appDir 'product.json'
			if (-not (Test-Path -LiteralPath $productPath -PathType Leaf)) {
				continue
			}

			try {
				$product = Get-Content -LiteralPath $productPath -Raw | ConvertFrom-Json
				if ($product.version -eq '1.141.0' -and
					$product.commit -eq '2a59476c9bfcb90b3ddc372c36762471b7dfad1c' -and
					$product.applicationName -eq 'code') {
					$matches += [IO.Path]::GetFullPath($appDir)
				}
			} catch {
				# Ignore unrelated or incomplete product metadata while locating the fixture source.
			}
		}
	}

	$matches = @($matches | Select-Object -Unique)
	if ($matches.Count -ne 1) {
		throw "Expected exactly one supported official VS Code app directory, found $($matches.Count). Pass -OfficialAppDir explicitly."
	}

	return $matches[0]
}

if ([string]::IsNullOrWhiteSpace($PatchScript)) {
	$PatchScript = Join-Path $PSScriptRoot 'patch-official-vscode.ps1'
}
if ([string]::IsNullOrWhiteSpace($PatchBuildDir)) {
	$PatchBuildDir = Join-Path $PSScriptRoot '..\payload'
}
if ([string]::IsNullOrWhiteSpace($OfficialAppDir)) {
	$OfficialAppDir = Resolve-OfficialAppDir
}

$bundleRelativePaths = @(
	'main.js',
	'vs/workbench/workbench.desktop.main.js',
	'vs/workbench/workbench.desktop.main.css',
	'vs/workbench/api/node/extensionHostProcess.js',
	'vs/workbench/api/worker/extensionHostWorkerMain.js',
	'vs/sessions/sessions.desktop.main.js'
)

$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $temporaryRoot ('codex-native-diff-test-' + [Guid]::NewGuid().ToString('N'))))
if (-not $fixtureRoot.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
	throw "Unsafe fixture path: $fixtureRoot"
}

$fixtureInstallDir = Join-Path $fixtureRoot 'official'
$fixtureAppDir = Join-Path $fixtureInstallDir '2a59476c9b\resources\app'
$fixtureOutDir = Join-Path $fixtureAppDir 'out'
$fixtureBackupRoot = Join-Path $fixtureRoot 'backups'
$originalHashes = @{}
$testPassed = $false
$utf8WithoutBom = New-Object Text.UTF8Encoding($false)

try {
	$null = New-Item -ItemType Directory -Path $fixtureAppDir -Force
	$productSourcePath = Join-Path $OfficialAppDir 'product.json'
	$productFixturePath = Join-Path $fixtureAppDir 'product.json'
	Copy-Item -LiteralPath $productSourcePath -Destination $productFixturePath
	$productRaw = [IO.File]::ReadAllText($productFixturePath)

	foreach ($relativePath in $bundleRelativePaths) {
		$sourcePath = Join-Path (Join-Path $OfficialAppDir 'out') $relativePath
		$fixturePath = Join-Path $fixtureOutDir $relativePath
		$null = New-Item -ItemType Directory -Path (Split-Path -Parent $fixturePath) -Force
		Copy-Item -LiteralPath $sourcePath -Destination $fixturePath
		[IO.File]::AppendAllText($fixturePath, "`r`n// portable patch regression baseline", $utf8WithoutBom)

		$relativePathPattern = [Regex]::Escape($relativePath.Replace('\', '/'))
		$checksumPattern = '("' + $relativePathPattern + '"\s*:\s*")[^"]*(")'
		$checksumMatches = [Regex]::Matches($productRaw, $checksumPattern)
		if ($checksumMatches.Count -gt 1) {
			throw "Expected at most one checksum entry for fixture bundle: $relativePath"
		}
		if ($checksumMatches.Count -eq 1) {
			$newHash = Get-Base64Sha256 $fixturePath
			$evaluator = {
				param($match)
				return $match.Groups[1].Value + $newHash + $match.Groups[2].Value
			}.GetNewClosure()
			$productRaw = [Regex]::Replace($productRaw, $checksumPattern, $evaluator)
		}

		$originalHashes[$relativePath] = (Get-FileHash -LiteralPath $fixturePath -Algorithm SHA256).Hash
	}

	[IO.File]::WriteAllText($productFixturePath, $productRaw, $utf8WithoutBom)
	$null = Get-Content -LiteralPath $productFixturePath -Raw | ConvertFrom-Json
	$originalHashes['product.json'] = (Get-FileHash -LiteralPath $productFixturePath -Algorithm SHA256).Hash

	Write-Host "Fixture: $fixtureRoot"
	foreach ($field in @('version', 'commit')) {
		$unsupportedProduct = $productRaw | ConvertFrom-Json
		$unsupportedProduct.$field = if ($field -eq 'version') { '0.0.0' } else { '0000000000000000000000000000000000000000' }
		[IO.File]::WriteAllText($productFixturePath, ($unsupportedProduct | ConvertTo-Json -Depth 100), $utf8WithoutBom)
		$rejected = $false
		try {
			& $PatchScript -Action Apply -OfficialInstallDir $fixtureInstallDir -PatchBuildDir $PatchBuildDir -BackupRoot $fixtureBackupRoot
		} catch {
			if (-not $_.Exception.Message.Contains('The exact supported official VS Code build was not found')) { throw }
			$rejected = $true
		}
		if (-not $rejected) { throw "Unsupported $field was not rejected." }
		foreach ($relativePath in $bundleRelativePaths) {
			if ((Get-FileHash -LiteralPath (Join-Path $fixtureOutDir $relativePath) -Algorithm SHA256).Hash -ne $originalHashes[$relativePath]) {
				throw "Unsupported $field modified a runtime bundle: $relativePath"
			}
		}
		[IO.File]::WriteAllText($productFixturePath, $productRaw, $utf8WithoutBom)
	}
	Write-Host 'Unsupported version and commit rejection: PASS'
	& $PatchScript -Action Apply -OfficialInstallDir $fixtureInstallDir -PatchBuildDir $PatchBuildDir -BackupRoot $fixtureBackupRoot
	& $PatchScript -Action Verify -OfficialInstallDir $fixtureInstallDir -PatchBuildDir $PatchBuildDir -BackupRoot $fixtureBackupRoot
	$patchedProduct = Get-Content -LiteralPath $productFixturePath -Raw | ConvertFrom-Json
	$sourceProduct = Get-Content -LiteralPath (Join-Path $PatchBuildDir 'product.json') -Raw | ConvertFrom-Json
	foreach ($relativePath in $bundleRelativePaths) {
		$sourceChecksumProperty = $sourceProduct.checksums.PSObject.Properties[$relativePath]
		if ($null -ne $sourceChecksumProperty -and
			[string]$patchedProduct.checksums.PSObject.Properties[$relativePath].Value -ne [string]$sourceChecksumProperty.Value) {
			throw "Patched checksum does not match the optimized build checksum format: $relativePath"
		}
	}

	$backupDirectories = @(Get-ChildItem -LiteralPath $fixtureBackupRoot -Directory)
	if ($backupDirectories.Count -ne 1) {
		throw "Expected one backup after Apply, found $($backupDirectories.Count)."
	}

	& $PatchScript -Action Apply -OfficialInstallDir $fixtureInstallDir -PatchBuildDir $PatchBuildDir -BackupRoot $fixtureBackupRoot
	$backupDirectoriesAfterSecondApply = @(Get-ChildItem -LiteralPath $fixtureBackupRoot -Directory)
	if ($backupDirectoriesAfterSecondApply.Count -ne 1) {
		throw 'Idempotent Apply created an unexpected second backup.'
	}

	[IO.File]::WriteAllText($productFixturePath, '{ interrupted product.json write', $utf8WithoutBom)
	& $PatchScript -Action Restore -OfficialInstallDir $fixtureInstallDir -PatchBuildDir $PatchBuildDir -BackupRoot $fixtureBackupRoot -BackupPath $backupDirectories[0].FullName

	if ((Get-FileHash -LiteralPath $productFixturePath -Algorithm SHA256).Hash -ne $originalHashes['product.json']) {
		throw 'Restored product.json differs from the original.'
	}
	foreach ($relativePath in $bundleRelativePaths) {
		$fixturePath = Join-Path $fixtureOutDir $relativePath
		if ((Get-FileHash -LiteralPath $fixturePath -Algorithm SHA256).Hash -ne $originalHashes[$relativePath]) {
			throw "Restored bundle differs from the original: $relativePath"
		}
	}

	Write-Host 'Apply, Verify, idempotency, and Restore tests: PASS'
	$testPassed = $true
} finally {
	if ($testPassed -and (Test-Path -LiteralPath $fixtureRoot)) {
		$resolvedFixtureRoot = [IO.Path]::GetFullPath($fixtureRoot)
		if (-not $resolvedFixtureRoot.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
			throw "Refusing to clean up outside the temporary directory: $resolvedFixtureRoot"
		}
		Remove-Item -LiteralPath $resolvedFixtureRoot -Recurse -Force
		Write-Host 'Fixture cleanup: PASS'
	} elseif (-not $testPassed) {
		Write-Host "Fixture preserved for diagnosis: $fixtureRoot"
	}
}
