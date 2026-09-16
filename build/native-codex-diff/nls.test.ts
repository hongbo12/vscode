/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createNLSCollector, finalizeNLS, postProcessNLS } from '../next/nls-plugin.ts';

test('patch localization retains official indices and appends new messages', async () => {
	const tempRoot = path.resolve(os.tmpdir());
	const directory = await fs.mkdtemp(path.join(tempRoot, 'native-diff-nls-'));
	try {
		const collector = createNLSCollector();
		collector.add({ moduleId: 'z', key: 'existing', message: 'Existing', placeholder: '%%NLS:z/existing%%' });
		collector.add({ moduleId: 'a', key: 'new', message: 'New', placeholder: '%%NLS:a/new%%' });
		const result = await finalizeNLS(collector, directory, undefined, {
			keys: [['z', ['existing', 'unused']]], messages: ['Existing', 'Unused'],
		});
		assert.deepEqual({ indices: [...result.indexMap.values()], messages: JSON.parse(await fs.readFile(path.join(directory, 'nls.messages.json'), 'utf8')) }, {
			indices: [0, 1, 2], messages: ['Existing', 'Unused', 'New'],
		});
		assert.equal(postProcessNLS('localize("%%NLS:a/new%%", "New")', result.indexMap, true).code, 'localize(2, "New")');
		await assert.rejects(finalizeNLS(collector, directory, undefined, {
			keys: [['z', ['existing']]], messages: ['Changed upstream text'],
		}), /Incompatible localization reference/);
		await assert.rejects(finalizeNLS(collector, directory, undefined, {
			keys: [['z', ['existing']]], messages: ['Existing', 'Extra'],
		}), /different lengths/);
	} finally {
		assert.ok(path.resolve(directory).startsWith(tempRoot + path.sep));
		await fs.rm(directory, { recursive: true });
	}
});
