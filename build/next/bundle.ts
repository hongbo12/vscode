/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as esbuild from 'esbuild';
import type { BuildTarget } from './resources.ts';

const fileHeader = `/*!--------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/`;

export function getBootstrapBundleOptions(minify: boolean, target: BuildTarget, entry: string): esbuild.BuildOptions {
	return {
		...getBundleOptions(minify, 'node'),
		// Main's static imports are resolved before bootstrap-esm installs its fs hook.
		// Other entry points can run on plain Node.js, where original-fs is unavailable.
		alias: target === 'desktop' && entry === 'main' ? { fs: 'original-fs' } : undefined,
	};
}

export function getBundleOptions(minify: boolean, platform: 'neutral' | 'node'): esbuild.BuildOptions {
	return {
		bundle: true,
		format: 'esm',
		platform,
		target: ['es2024'],
		packages: 'external',
		sourcemap: 'linked',
		sourcesContent: true,
		minify,
		treeShaking: true,
		// esbuild emits and scopes the helpers needed by each input. Keep executable
		// code out of banners, which esbuild cannot tree-shake, minify, or rename.
		banner: { js: fileHeader, css: fileHeader },
		write: false,
		logLevel: 'warning',
		logOverride: {
			'unsupported-require-call': 'silent',
		},
		tsconfigRaw: JSON.stringify({
			compilerOptions: {
				experimentalDecorators: true,
				useDefineForClassFields: false
			}
		}),
	};
}
