/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { suite, test } from 'node:test';
import * as esbuild from 'esbuild';
import { getBootstrapBundleOptions } from '../bundle.ts';

suite('bootstrap bundle file system', () => {
	for (const { target, entry, expected } of [
		{ target: 'desktop', entry: 'main', expected: ['original-fs', 'node:fs'] },
		{ target: 'desktop', entry: 'cli', expected: ['fs', 'node:fs'] },
		{ target: 'desktop', entry: 'bootstrap-fork', expected: ['fs', 'node:fs'] },
		{ target: 'server', entry: 'server-main', expected: ['fs', 'node:fs'] },
		{ target: 'server-web', entry: 'server-main', expected: ['fs', 'node:fs'] },
	] as const) {
		test(`${target}/${entry} selects the appropriate file system before startup`, async () => {
			const result = await esbuild.build({
				...getBootstrapBundleOptions(false, target, entry),
				stdin: {
					contents: `import { readFileSync } from 'fs'; import { readFileSync as readArchive } from 'node:fs'; export { readFileSync, readArchive };`,
				},
				outfile: 'bootstrap-test.js',
				metafile: true,
			});
			assert.deepStrictEqual(result.metafile.outputs['bootstrap-test.js'].imports.map(value => value.path), expected);
		});
	}
});
