/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import ts from 'typescript';

/** Preserve the official main bundle except for static imports resolved before its startup hook. */
export function patchMainFileSystem(content) {
	const source = ts.createSourceFile('main.js', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	assert.equal(source.parseDiagnostics.length, 0, 'Official main bundle must parse before patching');
	const imports = source.statements.filter(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier));
	const edits = imports.filter(statement => statement.moduleSpecifier.text === 'fs')
		.map(statement => ({ start: statement.moduleSpecifier.getStart(source) + 1, end: statement.moduleSpecifier.getEnd() - 1 }));
	assert.ok(edits.length > 0 || imports.some(statement => statement.moduleSpecifier.text === 'original-fs'), 'Expected Electron file system imports in the official main bundle');
	let code = content;
	for (const edit of edits.toReversed()) {
		code = code.slice(0, edit.start) + 'original-fs' + code.slice(edit.end);
	}
	return { code, replacements: edits.length };
}
