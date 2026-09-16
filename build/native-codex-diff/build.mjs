/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const target = JSON.parse(fs.readFileSync(path.join(here, 'target.json'), 'utf8'));
const cache = path.join(repo, '.build/native-codex-diff');
const statePath = path.join(cache, 'latest.json');
const command = process.argv[2] ?? 'all';
const appIndex = process.argv.indexOf('--official-app-dir');
const officialApp = appIndex >= 0 ? path.resolve(process.argv[appIndex + 1]) : undefined;
const hash = data => createHash('sha256').update(data).digest('hex');
const bundleHash = data => createHash('sha256').update(data).digest('base64').replace(/=+$/, '');
const read = file => fs.readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

function run(exe, args, cwd = repo, input) {
	const result = spawnSync(exe, args, { cwd, input, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
		stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'] });
	if (result.error) { throw result.error; }
	if (result.status !== 0) { throw new Error(`${exe} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`); }
	return result.stdout;
}

function runVisible(exe, args, cwd) {
	// Windows PowerShell must discover its own built-in modules when the parent is PowerShell 7.
	const env = exe === 'powershell.exe' ? { ...process.env, PSModulePath: '' } : process.env;
	const result = spawnSync(exe, args, { cwd, stdio: 'inherit', windowsHide: true, env });
	if (result.error) { throw result.error; }
	if (result.status !== 0) { throw new Error(`${exe} exited with ${result.status}`); }
}

function npm(args, cwd) {
	// npm.cmd is a shell script on Windows; keep the invoked command fixed.
	if (process.platform === 'win32') {
		assert.deepEqual(args, ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
		runVisible('cmd.exe', ['/d', '/c', 'npm.cmd ci --ignore-scripts --no-audit --no-fund'], cwd);
	} else { runVisible('npm', args, cwd); }
}

function sourcePatch() {
	// The release builder predates the checkout's split build modules. Its explicit
	// versioned patch keeps the release layout while preserving our build changes.
	const compatibilityPatches = target.compatibilityPatches ?? {};
	let patch = run('git', ['diff', '--binary', target.developmentBase, '--', ...target.modifiedFiles.filter(file => !Object.hasOwn(compatibilityPatches, file))]);
	for (const patchFile of Object.values(compatibilityPatches)) {
		patch += read(path.join(here, patchFile));
	}
	for (const file of target.newFiles) {
		const content = read(path.join(repo, file)).replaceAll('\r\n', '\n');
		assert.ok(content.endsWith('\n'), `${file} must end with a newline`);
		const lines = content.slice(0, -1).split('\n');
		patch += `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map(line => '+' + line + '\n').join('');
	}
	return patch;
}

function prepare() {
	fs.mkdirSync(cache, { recursive: true });
	const patch = sourcePatch();
	const sourceHash = hash(patch);
	if (fs.existsSync(statePath)) {
		const previous = json(statePath);
		if (previous.sourceHash === sourceHash) { assertState(previous); return previous; }
	}
	run('git', ['cat-file', '-e', `${target.officialCommit}^{commit}`]);
	const worktree = path.join(cache, `compat-${target.version}-${sourceHash.slice(0, 12)}`);
	assert.ok(!fs.existsSync(worktree), `Existing build directory requires inspection: ${worktree}`);
	console.log(`Preparing ${target.version} from ${target.officialCommit}`);
	runVisible('git', ['worktree', 'add', '--detach', worktree, target.officialCommit], repo);
	const patchPath = path.join(cache, `${sourceHash}.patch`);
	fs.writeFileSync(patchPath, patch);
	// A three-way application retains the official release's unrelated code. Conflicts stop the build.
	runVisible('git', ['apply', '--3way', '--index', patchPath], worktree);
	assert.equal(json(path.join(worktree, 'package.json')).version, target.version);
	const appliedPatch = run('git', ['diff', '--binary', target.officialCommit, '--'], worktree);
	const state = { worktree, sourceHash, appliedHash: hash(appliedPatch), officialCommit: target.officialCommit };
	writeJson(statePath, state);
	console.log(`Compatibility sources: ${worktree}`);
	return state;
}

function assertState(state) {
	assert.equal(state.officialCommit, target.officialCommit, 'Build target changed; prepare a new worktree');
	assert.equal(run('git', ['rev-parse', 'HEAD'], state.worktree).trim(), target.officialCommit);
	assert.equal(hash(sourcePatch()), state.sourceHash, 'Sources changed after prepare');
	assert.equal(hash(run('git', ['diff', '--binary', target.officialCommit, '--'], state.worktree)), state.appliedHash, 'Generated compatibility sources were modified');
	assert.equal(run('git', ['ls-files', '--others', '--exclude-standard'], state.worktree).trim(), '', 'Untracked files in compatibility source tree');
}

function checkOfficial() {
	assert.ok(officialApp, 'Pass --official-app-dir pointing to the matching resources/app directory');
	const product = json(path.join(officialApp, 'product.json'));
	assert.equal(product.version, target.version, 'Official editor version mismatch');
	assert.equal(product.commit, target.officialCommit, 'Official editor commit mismatch');
	for (const name of ['nls.keys.json', 'nls.messages.json']) { assert.ok(fs.existsSync(path.join(officialApp, 'out', name)), `Missing localization reference: ${name}`); }
	return product;
}

function build(state) {
	assertState(state);
	checkOfficial();
	for (const directory of [state.worktree, path.join(state.worktree, 'build')]) {
		const lockHash = hash(fs.readFileSync(path.join(directory, 'package-lock.json')));
		const receipt = path.join(directory, 'node_modules/.native-diff-lock');
		if (!fs.existsSync(receipt) || read(receipt) !== lockHash) {
			npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], directory);
			fs.writeFileSync(receipt, lockHash);
		}
	}
	// Match the repository's copy-codicons task before bundling CSS resources.
	fs.copyFileSync(path.join(state.worktree, 'node_modules/@vscode/codicons/dist/codicon.ttf'),
		path.join(state.worktree, 'src/vs/base/browser/ui/codicons/codicon/codicon.ttf'));
	console.log('Building the compatible release and preserving official localization indices...');
	runVisible(process.execPath, ['build/next/index.ts', 'bundle', '--minify', '--nls', '--nls-reference', path.join(officialApp, 'out'), '--out', 'out-native-codex-diff'], state.worktree);
	const output = path.join(state.worktree, 'out-native-codex-diff');
	const bundleHashes = Object.fromEntries(target.bundles.map(file => [file, bundleHash(fs.readFileSync(path.join(output, file)))]));
	writeJson(path.join(cache, 'build.json'), { ...state, bundleHashes, nlsReferenceHash: hash(fs.readFileSync(path.join(officialApp, 'out/nls.messages.json'))) });
}

function packageBuild(state) {
	assertState(state);
	const official = checkOfficial();
	const built = json(path.join(cache, 'build.json'));
	assert.equal(built.appliedHash, state.appliedHash, 'Build receipt does not match the sources');
	assert.equal(built.nlsReferenceHash, hash(fs.readFileSync(path.join(officialApp, 'out/nls.messages.json'))));
	const output = path.join(state.worktree, 'out-native-codex-diff');
	const packagingFiles = ['build.mjs', 'target.json', 'PACKAGE-README.md', 'templates/install-native-codex-inline-diff.bat',
		'templates/scripts/patch-official-vscode.ps1', 'templates/scripts/test-portable-package.ps1', 'templates/scripts/test-patch-official-vscode.ps1'];
	const packagingHash = hash(packagingFiles.map(file => `${file}:${hash(fs.readFileSync(path.join(here, file)))}`).join('\n'));
	const packageRoot = path.join(repo, 'dist/native-codex-diff', `${target.version}-${state.sourceHash.slice(0, 12)}-${packagingHash.slice(0, 8)}`, 'portable-vscode-native-inline-diff');
	assert.ok(!fs.existsSync(packageRoot), `Package already exists: ${packageRoot}`);
	fs.mkdirSync(packageRoot, { recursive: true });
	fs.cpSync(path.join(here, 'templates'), packageRoot, { recursive: true });
	let installDirectory = officialApp;
	while (!fs.existsSync(path.join(installDirectory, 'Code.exe'))) {
		const parent = path.dirname(installDirectory);
		assert.notEqual(parent, installDirectory, 'Cannot locate Code.exe above the official application directory');
		installDirectory = parent;
	}
	assert.ok(!/[\r\n"]/u.test(installDirectory), 'Unsupported install directory for the batch launcher');
	fs.writeFileSync(path.join(packageRoot, 'install-target.local.cmd'), `@set "OFFICIAL_INSTALL_DIR=${installDirectory.replaceAll('%', '%%')}"\r\n`);
	const patch = run('git', ['diff', '--binary', target.officialCommit, '--'], state.worktree);
	fs.writeFileSync(path.join(packageRoot, 'source-changes.patch'), patch);
	const hashes = {};
	for (const file of target.bundles) {
		const data = fs.readFileSync(path.join(output, file));
		hashes[file] = bundleHash(data);
		assert.equal(hashes[file], built.bundleHashes[file], `Built bundle changed: ${file}`);
		const destination = path.join(packageRoot, 'payload/bundles', file);
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.writeFileSync(destination, data);
	}
	const checksums = Object.fromEntries(target.bundles.filter(file => Object.hasOwn(official.checksums, file)).map(file => [file, hashes[file]]));
	const revision = `source-${state.sourceHash.slice(0, 12)}`;
	const product = { version: target.version, commit: target.officialCommit, checksums,
		nativeReviewPatch: { revision, sourceDiffSha256: hash(patch).toUpperCase(), developmentCommit: run('git', ['rev-parse', 'HEAD']).trim(), developmentBase: target.developmentBase, sourceHash: state.sourceHash } };
	writeJson(path.join(packageRoot, 'payload/product.json'), product);
	for (const name of ['patch-official-vscode.ps1', 'test-portable-package.ps1']) {
		const scriptPath = path.join(packageRoot, 'scripts', name);
		let text = read(scriptPath).replaceAll('14c79d4bed33adba68885de4a1785143a824d311', target.officialCommit).replaceAll('2026-09-16-review-fixes', revision);
		for (const [file, value] of Object.entries(hashes)) {
			const escaped = file.replaceAll('/', name === 'test-portable-package.ps1' ? '\\' : '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const expression = new RegExp(`('${escaped}' = ')[^']+(')`);
			assert.ok(expression.test(text), `Missing hash placeholder for ${file}`);
			text = text.replace(expression, (_all, prefix, suffix) => prefix + value + suffix);
		}
		fs.writeFileSync(scriptPath, text);
	}
	fs.copyFileSync(path.join(here, 'PACKAGE-README.md'), path.join(packageRoot, 'README.md'));
	writeJson(path.join(packageRoot, 'build-manifest.json'), { ...product.nativeReviewPatch, packagingHash, version: target.version, officialCommit: target.officialCommit, hashes });
	runVisible('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(packageRoot, 'scripts/test-portable-package.ps1')], repo);
	runVisible('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(packageRoot, 'scripts/test-patch-official-vscode.ps1'), '-OfficialAppDir', officialApp], repo);
	const zip = path.join(path.dirname(packageRoot), 'portable-vscode-native-inline-diff.zip');
	const zipCommand = `Compress-Archive -LiteralPath '${packageRoot.replaceAll("'", "''")}' -DestinationPath '${zip.replaceAll("'", "''")}' -CompressionLevel Optimal`;
	runVisible('powershell.exe', ['-NoProfile', '-Command', zipCommand], repo);
	console.log(`Verified package: ${packageRoot}\nArchive: ${zip}`);
}

try {
	assert.ok(['prepare', 'build', 'package', 'all'].includes(command), 'Use prepare, build, package, or all');
	const state = command === 'prepare' || command === 'all' ? prepare() : json(statePath);
	if (command === 'build' || command === 'all') { build(state); }
	if (command === 'package' || command === 'all') { packageBuild(state); }
} catch (error) { console.error(error); process.exitCode = 1; }
