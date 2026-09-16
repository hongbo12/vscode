/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patchMainFileSystem } from './runtime-patches.mjs';

test('changes static file imports while preserving archive-aware imports, code and metadata', () => {
	const input = `import*as a from"fs";import{promises as b}from'fs';import*as c from"node:fs";const product={name:"Code",text:"from fs"};const d=require("fs");const e=import("fs");`;
	assert.deepEqual(patchMainFileSystem(input), {
		code: `import*as a from"original-fs";import{promises as b}from'original-fs';import*as c from"node:fs";const product={name:"Code",text:"from fs"};const d=require("fs");const e=import("fs");`,
		replacements: 2,
	});
});

test('a patched bundle is unchanged on a second pass', () => {
	const { code } = patchMainFileSystem('import * as fs from "fs";');
	assert.deepEqual(patchMainFileSystem(code), { code, replacements: 0 });
});

test('unexpected or malformed bundles stop packaging', () => {
	assert.throws(() => patchMainFileSystem('const value = 1;'), /Expected Electron/);
	assert.throws(() => patchMainFileSystem('import { from "fs";'), /must parse/);
});
