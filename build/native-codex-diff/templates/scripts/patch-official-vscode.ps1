#requires -Version 5.1
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root.

<#
.SYNOPSIS
Applies the Codex native inline diff runtime bundles to the matching official VS Code build.

.DESCRIPTION
This script is intentionally locked to the official VS Code 1.137.0 build whose commit is
645f29cc3176500b4b5762ba887cf2a7f0ffdf2c. It preserves the official product identity and
user-data directories. Apply creates a complete backup before replacing five runtime
bundles and updates only the four matching checksum values in product.json.

.EXAMPLE
.\scripts\patch-official-vscode.ps1 -Action Plan

.EXAMPLE
.\scripts\patch-official-vscode.ps1 -Action Apply

.EXAMPLE
.\scripts\patch-official-vscode.ps1 -Action Verify

.EXAMPLE
.\scripts\patch-official-vscode.ps1 -Action Restore -BackupPath '<backup directory>'
#>

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
	[ValidateSet('Plan', 'Apply', 'Verify', 'Restore')]
	[string]$Action = 'Plan',

	[string]$OfficialInstallDir = '',

	[string]$PatchBuildDir = '',

	[string]$BackupRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CodexNativeDiffPatch\backups'),

	[string]$BackupPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$SupportedVersion = '1.137.0'
$SupportedOfficialCommit = '645f29cc3176500b4b5762ba887cf2a7f0ffdf2c'
$ExpectedPatchCommit = '14c79d4bed33adba68885de4a1785143a824d311'
$BundleRelativePaths = @(
	'vs/workbench/workbench.desktop.main.js',
	'vs/workbench/workbench.desktop.main.css',
	'vs/workbench/api/node/extensionHostProcess.js',
	'vs/workbench/api/worker/extensionHostWorkerMain.js',
	'vs/sessions/sessions.desktop.main.js'
)
$ExpectedPatchBundleHashes = @{
	'vs/workbench/workbench.desktop.main.js' = 'N+r2mJlf7IUR3WtjmTquJGqz62FVf8DLgk+9Nx9tvrg'
	'vs/workbench/workbench.desktop.main.css' = 'E8EPBzg71CfVy6b9dDS5GrUwZlEbksdDe5WOIhRSnqo'
	'vs/workbench/api/node/extensionHostProcess.js' = 'BmT31kS/ltMJC4wKLVuuUiG0rzwe+k5bwv4y464ZcDc'
	'vs/workbench/api/worker/extensionHostWorkerMain.js' = 'l7IZNgTZEWKhXtEQqddYjslhz3xFQx2AOTBqOLU9eqo'
	'vs/sessions/sessions.desktop.main.js' = '5xTLkctKnqnRAK5RLTM/K2z0h3driMkMc8EZnPDqosg'
}
$RequiredBundleMarkers = @{
	'vs/workbench/workbench.desktop.main.js' = 'Codex native edit review failed'
	'vs/workbench/workbench.desktop.main.css' = 'margin:12px 12px 0 0'
	'vs/workbench/api/node/extensionHostProcess.js' = 'Codex native edit review failed'
	'vs/workbench/api/worker/extensionHostWorkerMain.js' = 'Codex native edit review failed'
	'vs/sessions/sessions.desktop.main.js' = 'Codex native edit review failed'
}

function Get-FullPath {
	param([Parameter(Mandatory = $true)][string]$Path)

	if ([string]::IsNullOrWhiteSpace($Path)) {
		throw 'A required path is empty.'
	}

	return [IO.Path]::GetFullPath($Path)
}

function Assert-PathWithin {
	param(
		[Parameter(Mandatory = $true)][string]$BasePath,
		[Parameter(Mandatory = $true)][string]$CandidatePath
	)

	$baseFullPath = (Get-FullPath $BasePath).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
	$candidateFullPath = Get-FullPath $CandidatePath
	if (-not $candidateFullPath.StartsWith($baseFullPath, [StringComparison]::OrdinalIgnoreCase)) {
		throw "Path escapes the expected directory: $candidateFullPath"
	}

	return $candidateFullPath
}

function Read-JsonFile {
	param([Parameter(Mandatory = $true)][string]$Path)

	if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
		throw "JSON file does not exist: $Path"
	}

	try {
		return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
	} catch {
		throw "Invalid JSON file '$Path': $($_.Exception.Message)"
	}
}

function Write-Utf8NoBom {
	param(
		[Parameter(Mandatory = $true)][string]$Path,
		[Parameter(Mandatory = $true)][string]$Content
	)

	$encoding = New-Object Text.UTF8Encoding($false)
	[IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Get-Base64Sha256 {
	param([Parameter(Mandatory = $true)][string]$Path)

	if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
		throw "File does not exist: $Path"
	}

	$stream = [IO.File]::OpenRead($Path)
	try {
		$sha256 = [Security.Cryptography.SHA256]::Create()
		try {
			$hash = [Convert]::ToBase64String($sha256.ComputeHash($stream))
			return $hash.TrimEnd('=')
		} finally {
			$sha256.Dispose()
		}
	} finally {
		$stream.Dispose()
	}
}

function Get-OfficialContext {
	param([Parameter(Mandatory = $true)][string]$InstallDir)

	$installFullPath = Get-FullPath $InstallDir
	if (-not (Test-Path -LiteralPath $installFullPath -PathType Container)) {
		throw "Official VS Code install directory does not exist: $installFullPath"
	}
	$officialExecutablePath = Join-Path $installFullPath 'Code.exe'
	if (Test-Path -LiteralPath $officialExecutablePath -PathType Leaf) {
		$officialExecutable = Get-Item -LiteralPath $officialExecutablePath
		if ($officialExecutable.VersionInfo.ProductVersion -ne $SupportedVersion) {
			throw "The active official Code.exe version '$($officialExecutable.VersionInfo.ProductVersion)' does not match supported version '$SupportedVersion'."
		}
		$signature = Get-AuthenticodeSignature -LiteralPath $officialExecutablePath
		if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or
			$null -eq $signature.SignerCertificate -or
			-not $signature.SignerCertificate.Subject.Contains('O=Microsoft Corporation')) {
			throw "The target Code.exe does not have the expected valid Microsoft signature: $officialExecutablePath"
		}
	}

	$candidateProductPaths = @()
	$directProductPath = Join-Path $installFullPath 'resources\app\product.json'
	if (Test-Path -LiteralPath $directProductPath -PathType Leaf) {
		$candidateProductPaths += $directProductPath
	}

	foreach ($directory in Get-ChildItem -LiteralPath $installFullPath -Directory -ErrorAction SilentlyContinue) {
		$productPath = Join-Path $directory.FullName 'resources\app\product.json'
		if (Test-Path -LiteralPath $productPath -PathType Leaf) {
			$candidateProductPaths += $productPath
		}
	}

	$matches = @()
	foreach ($candidateProductPath in @($candidateProductPaths | Select-Object -Unique)) {
		try {
			$product = Read-JsonFile $candidateProductPath
			if ($product.version -eq $SupportedVersion -and
				$product.commit -eq $SupportedOfficialCommit -and
				$product.applicationName -eq 'code') {
				$matches += [pscustomobject]@{
					InstallDir = $installFullPath
					ExecutablePath = Get-FullPath $officialExecutablePath
					ProductPath = Get-FullPath $candidateProductPath
					AppDir = Get-FullPath (Split-Path -Parent $candidateProductPath)
					OutDir = Get-FullPath (Join-Path (Split-Path -Parent $candidateProductPath) 'out')
					Product = $product
				}
			}
		} catch {
			# Ignore unrelated or incomplete version directories while locating the exact supported build.
		}
	}

	if ($matches.Count -eq 0) {
		throw "The exact supported official VS Code build was not found. Expected version $SupportedVersion and commit $SupportedOfficialCommit under $installFullPath."
	}
	if ($matches.Count -gt 1) {
		throw "More than one matching official VS Code product.json was found under $installFullPath. Remove stale duplicate installs or pass a more specific -OfficialInstallDir."
	}

	return $matches[0]
}

function Resolve-DefaultOfficialInstallDir {
	$candidates = @(@(
		(Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\Microsoft VS Code'),
		(Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Microsoft VS Code'),
		(Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft VS Code')
	) | Where-Object {
		-not [string]::IsNullOrWhiteSpace($_) -and
		(Test-Path -LiteralPath (Join-Path $_ 'Code.exe') -PathType Leaf)
	} | Select-Object -Unique)

	if ($candidates.Count -eq 1) {
		return [IO.Path]::GetFullPath($candidates[0])
	}
	if ($candidates.Count -gt 1) {
		throw "More than one official VS Code installation was found. Pass -OfficialInstallDir explicitly: $($candidates -join ', ')"
	}

	throw 'Official VS Code could not be located in the standard User Setup or System Setup directories. Pass -OfficialInstallDir explicitly.'
}

function Get-PatchContext {
	param([Parameter(Mandatory = $true)][string]$BuildDir)

	$buildFullPath = Get-FullPath $BuildDir
	$productPath = Join-Path $buildFullPath 'product.json'
	$product = Read-JsonFile $productPath
	if ($product.version -ne $SupportedVersion) {
		throw "Patch build version '$($product.version)' does not match supported official version '$SupportedVersion'."
	}
	if ($product.commit -ne $ExpectedPatchCommit) {
		throw "Patch build commit '$($product.commit)' does not match the tested patch commit '$ExpectedPatchCommit'."
	}

	$outDir = Join-Path $buildFullPath 'bundles'
	foreach ($relativePath in $BundleRelativePaths) {
		$bundlePath = Assert-PathWithin $outDir (Join-Path $outDir $relativePath)
		if (-not (Test-Path -LiteralPath $bundlePath -PathType Leaf)) {
			throw "Patch bundle is missing: $bundlePath"
		}
		$actualHash = Get-Base64Sha256 $bundlePath
		$expectedHash = [string]$ExpectedPatchBundleHashes[$relativePath]
		if ($actualHash -ne $expectedHash) {
			throw "Patch bundle hash does not match the tested artifact: $bundlePath"
		}

		$marker = [string]$RequiredBundleMarkers[$relativePath]
		$bundleText = [IO.File]::ReadAllText($bundlePath)
		if (-not $bundleText.Contains($marker)) {
			throw "Patch bundle does not contain required marker '$marker': $bundlePath"
		}
	}

	return [pscustomobject]@{
		BuildDir = $buildFullPath
		ProductPath = Get-FullPath $productPath
		AppDir = $buildFullPath
		OutDir = Get-FullPath $outDir
		Product = $product
	}
}

function Get-RunningOfficialCodeProcesses {
	param([Parameter(Mandatory = $true)][string]$InstallDir)

	$installPrefix = (Get-FullPath $InstallDir).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
	$processes = @(Get-CimInstance Win32_Process -Filter "Name = 'Code.exe'" -ErrorAction SilentlyContinue | Where-Object {
		$null -ne $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase)
	})
	return $processes
}

function Assert-OfficialCodeIsClosed {
	param([Parameter(Mandatory = $true)][string]$InstallDir)

	$processes = @(Get-RunningOfficialCodeProcesses $InstallDir)
	if ($processes.Count -gt 0) {
		$processIds = ($processes | Select-Object -ExpandProperty ProcessId) -join ', '
		throw "Official VS Code is running (process IDs: $processIds). Save all files and exit every VS Code window before Apply or Restore."
	}
}

function Get-PatchState {
	param(
		[Parameter(Mandatory = $true)]$OfficialContext,
		[Parameter(Mandatory = $true)]$PatchContext
	)

	$rows = @()
	$allMatch = $true
	foreach ($relativePath in $BundleRelativePaths) {
		$sourcePath = Assert-PathWithin $PatchContext.OutDir (Join-Path $PatchContext.OutDir $relativePath)
		$targetPath = Assert-PathWithin $OfficialContext.OutDir (Join-Path $OfficialContext.OutDir $relativePath)
		if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
			throw "Official bundle is missing: $targetPath"
		}

		$sourceHash = Get-Base64Sha256 $sourcePath
		$targetHash = Get-Base64Sha256 $targetPath
		$fileMatches = $sourceHash -eq $targetHash
		$checksumProperty = $OfficialContext.Product.checksums.PSObject.Properties[$relativePath]
		$checksumTracked = $null -ne $checksumProperty
		$checksumMatches = -not $checksumTracked -or ([string]$checksumProperty.Value -eq $targetHash)
		if (-not $fileMatches -or -not $checksumMatches) {
			$allMatch = $false
		}

		$rows += [pscustomobject]@{
			RelativePath = $relativePath
			SourceHash = $sourceHash
			TargetHash = $targetHash
			FileMatches = $fileMatches
			ChecksumTracked = $checksumTracked
			ChecksumMatches = $checksumMatches
		}
	}

	return [pscustomobject]@{
		IsPatched = $allMatch
		Files = $rows
	}
}

function Show-PatchState {
	param([Parameter(Mandatory = $true)]$State)

	$State.Files | Select-Object RelativePath, FileMatches, ChecksumTracked, ChecksumMatches | Format-Table -AutoSize
	Write-Host "Patched: $($State.IsPatched)"
}

function New-PatchBackup {
	param(
		[Parameter(Mandatory = $true)]$OfficialContext,
		[Parameter(Mandatory = $true)]$PatchContext,
		[Parameter(Mandatory = $true)][string]$RootPath
	)

	$backupRootFullPath = Get-FullPath $RootPath
	$null = New-Item -ItemType Directory -Path $backupRootFullPath -Force
	$backupName = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'), $SupportedOfficialCommit.Substring(0, 10)
	$backupFullPath = Assert-PathWithin $backupRootFullPath (Join-Path $backupRootFullPath $backupName)
	if (Test-Path -LiteralPath $backupFullPath) {
		throw "Backup path already exists: $backupFullPath"
	}

	$originalRoot = Join-Path $backupFullPath 'original'
	$bundleBackupRoot = Join-Path $originalRoot 'bundles'
	$null = New-Item -ItemType Directory -Path $bundleBackupRoot -Force

	$productBackupPath = Join-Path $originalRoot 'product.json'
	Copy-Item -LiteralPath $OfficialContext.ProductPath -Destination $productBackupPath

	$manifestFiles = @()
	foreach ($relativePath in $BundleRelativePaths) {
		$sourcePath = Assert-PathWithin $OfficialContext.OutDir (Join-Path $OfficialContext.OutDir $relativePath)
		$destinationPath = Assert-PathWithin $bundleBackupRoot (Join-Path $bundleBackupRoot $relativePath)
		$null = New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPath) -Force
		Copy-Item -LiteralPath $sourcePath -Destination $destinationPath
		$manifestFiles += [ordered]@{
			relativePath = $relativePath
			originalHash = Get-Base64Sha256 $sourcePath
			patchedHash = Get-Base64Sha256 (Assert-PathWithin $PatchContext.OutDir (Join-Path $PatchContext.OutDir $relativePath))
		}
	}

	$productRelativePath = $OfficialContext.ProductPath.Substring($OfficialContext.InstallDir.Length).TrimStart('\', '/')
	$manifest = [ordered]@{
		schemaVersion = 1
		createdAt = (Get-Date).ToString('o')
		officialInstallDir = $OfficialContext.InstallDir
		productRelativePath = $productRelativePath
		officialVersion = $SupportedVersion
		officialCommit = $SupportedOfficialCommit
		patchBuildDir = $PatchContext.BuildDir
		patchBuildCommit = [string]$PatchContext.Product.commit
		originalProductHash = Get-Base64Sha256 $OfficialContext.ProductPath
		files = $manifestFiles
	}
	$manifestPath = Join-Path $backupFullPath 'manifest.json'
	Write-Utf8NoBom $manifestPath ($manifest | ConvertTo-Json -Depth 20)

	return $backupFullPath
}

function Set-OfficialChecksums {
	param(
		[Parameter(Mandatory = $true)][string]$ProductPath,
		[Parameter(Mandatory = $true)]$FileRows
	)

	$productRaw = [IO.File]::ReadAllText($ProductPath)
	foreach ($row in @($FileRows | Where-Object { $_.ChecksumTracked })) {
		$relativePath = [string]$row.RelativePath
		$newHash = [string]$row.SourceHash
		$pattern = '("' + [Regex]::Escape($relativePath) + '"\s*:\s*")[^"]*(")'
		$matches = [Regex]::Matches($productRaw, $pattern)
		if ($matches.Count -ne 1) {
			throw "Expected exactly one checksum entry for '$relativePath', found $($matches.Count)."
		}

		$evaluator = {
			param($match)
			return $match.Groups[1].Value + $newHash + $match.Groups[2].Value
		}.GetNewClosure()
		$productRaw = [Regex]::Replace($productRaw, $pattern, $evaluator)
	}

	Write-Utf8NoBom $ProductPath $productRaw
	$null = Read-JsonFile $ProductPath
}

function Restore-BackupInternal {
	param(
		[Parameter(Mandatory = $true)][string]$RestoreBackupPath,
		[Parameter(Mandatory = $true)][string]$InstallDir
	)

	$backupFullPath = Get-FullPath $RestoreBackupPath
	$manifestPath = Join-Path $backupFullPath 'manifest.json'
	$manifest = Read-JsonFile $manifestPath
	if ($manifest.schemaVersion -ne 1 -or
		$manifest.officialVersion -ne $SupportedVersion -or
		$manifest.officialCommit -ne $SupportedOfficialCommit) {
		throw "Backup manifest is not compatible with this patch script: $manifestPath"
	}

	$installFullPath = Get-FullPath $InstallDir
	if ((Get-FullPath ([string]$manifest.officialInstallDir)) -ne $installFullPath) {
		throw "Backup belongs to a different VS Code install directory: $($manifest.officialInstallDir)"
	}

	$productTargetPath = Assert-PathWithin $installFullPath (Join-Path $installFullPath ([string]$manifest.productRelativePath))
	$productBackupPath = Assert-PathWithin $backupFullPath (Join-Path $backupFullPath 'original\product.json')
	if ((Get-Base64Sha256 $productBackupPath) -ne [string]$manifest.originalProductHash) {
		throw "Backup product.json hash does not match its manifest: $productBackupPath"
	}

	$appDir = Split-Path -Parent $productTargetPath
	$outDir = Join-Path $appDir 'out'
	foreach ($file in $manifest.files) {
		$relativePath = [string]$file.relativePath
		$backupFilePath = Assert-PathWithin $backupFullPath (Join-Path (Join-Path $backupFullPath 'original\bundles') $relativePath)
		if ((Get-Base64Sha256 $backupFilePath) -ne [string]$file.originalHash) {
			throw "Backup bundle hash does not match its manifest: $backupFilePath"
		}
		$targetFilePath = Assert-PathWithin $outDir (Join-Path $outDir $relativePath)
		Copy-Item -LiteralPath $backupFilePath -Destination $targetFilePath -Force
	}
	Copy-Item -LiteralPath $productBackupPath -Destination $productTargetPath -Force

	if ((Get-Base64Sha256 $productTargetPath) -ne [string]$manifest.originalProductHash) {
		throw 'Restored product.json did not match the backup hash.'
	}
	foreach ($file in $manifest.files) {
		$targetFilePath = Assert-PathWithin $outDir (Join-Path $outDir ([string]$file.relativePath))
		if ((Get-Base64Sha256 $targetFilePath) -ne [string]$file.originalHash) {
			throw "Restored bundle did not match the backup hash: $targetFilePath"
		}
	}
}

if ([string]::IsNullOrWhiteSpace($OfficialInstallDir)) {
	$OfficialInstallDir = Resolve-DefaultOfficialInstallDir
}

if ($Action -eq 'Restore') {
	if ([string]::IsNullOrWhiteSpace($BackupPath)) {
		throw 'Restore requires -BackupPath.'
	}
	$restoreInstallDir = Get-FullPath $OfficialInstallDir
	if (-not (Test-Path -LiteralPath $restoreInstallDir -PathType Container)) {
		throw "Official VS Code install directory does not exist: $restoreInstallDir"
	}
	if (-not $PSCmdlet.ShouldProcess($restoreInstallDir, "Restore VS Code files from '$BackupPath'")) {
		return
	}
	Assert-OfficialCodeIsClosed $restoreInstallDir
	Restore-BackupInternal $BackupPath $restoreInstallDir
	Write-Host "Restore completed from: $(Get-FullPath $BackupPath)"
	return
}

if ([string]::IsNullOrWhiteSpace($PatchBuildDir)) {
	$PatchBuildDir = Get-FullPath (Join-Path $PSScriptRoot '..\payload')
}

$official = Get-OfficialContext $OfficialInstallDir
$patch = Get-PatchContext $PatchBuildDir

if ($Action -eq 'Plan') {
	$runningProcesses = @(Get-RunningOfficialCodeProcesses $official.InstallDir)
	Write-Host "Official version: $($official.Product.version)"
	Write-Host "Official commit:  $($official.Product.commit)"
	Write-Host "Official app:     $($official.AppDir)"
	Write-Host "Patch build:      $($patch.BuildDir)"
	Write-Host "Patch commit:     $($patch.Product.commit)"
	Write-Host "Backup root:      $(Get-FullPath $BackupRoot)"
	Write-Host "VS Code running:  $($runningProcesses.Count -gt 0)"
	Write-Host 'Files to patch:'
	$BundleRelativePaths | ForEach-Object { Write-Host "  $_" }
	$planState = Get-PatchState $official $patch
	Show-PatchState $planState
	return
}

if ($Action -eq 'Verify') {
	$verifyState = Get-PatchState $official $patch
	Show-PatchState $verifyState
	if (-not $verifyState.IsPatched) {
		throw 'The official VS Code installation is not fully patched.'
	}
	return
}

$currentState = Get-PatchState $official $patch
if ($currentState.IsPatched) {
	Write-Host 'The matching patch is already applied. No files were changed.'
	Show-PatchState $currentState
	return
}

if (-not $PSCmdlet.ShouldProcess($official.AppDir, 'Back up and apply the Codex native inline diff patch')) {
	return
}

Assert-OfficialCodeIsClosed $official.InstallDir
$createdBackupPath = New-PatchBackup $official $patch $BackupRoot
$mutationStarted = $false
try {
	foreach ($row in $currentState.Files) {
		$sourcePath = Assert-PathWithin $patch.OutDir (Join-Path $patch.OutDir $row.RelativePath)
		$targetPath = Assert-PathWithin $official.OutDir (Join-Path $official.OutDir $row.RelativePath)
		$mutationStarted = $true
		Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
	}

	Set-OfficialChecksums $official.ProductPath $currentState.Files
	$official = Get-OfficialContext $OfficialInstallDir
	$finalState = Get-PatchState $official $patch
	if (-not $finalState.IsPatched) {
		throw 'Post-patch verification failed.'
	}

	Write-Host "Patch completed. Backup: $createdBackupPath"
	Show-PatchState $finalState
} catch {
	$patchError = $_
	if ($mutationStarted) {
		try {
			Restore-BackupInternal $createdBackupPath $official.InstallDir
			throw "Patch failed and the original files were restored. Cause: $($patchError.Exception.Message)"
		} catch {
			if ($_.Exception.Message.StartsWith('Patch failed and the original files were restored.')) {
				throw
			}
			throw "Patch failed and automatic restore also failed. Backup: $createdBackupPath. Patch cause: $($patchError.Exception.Message). Restore cause: $($_.Exception.Message)"
		}
	}
	throw
}
