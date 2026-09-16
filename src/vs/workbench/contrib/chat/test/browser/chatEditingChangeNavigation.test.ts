/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { autorun, constObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { LineRange } from '../../../../../editor/common/core/ranges/lineRange.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { DetailedLineRangeMapping } from '../../../../../editor/common/diff/rangeMapping.js';
import { IDocumentDiff } from '../../../../../editor/common/diff/documentDiffProvider.js';
import { getChatEditingChangeNavigation, revealChatEditingChange } from '../../browser/chatEditing/chatEditingChangeNavigation.js';
import { ITextDiffEditorPane } from '../../../../common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IChatEditReviewSession, IModifiedFileEntry, IModifiedFileEntryEditorIntegration, ModifiedFileEntryState } from '../../common/editing/chatEditingService.js';

suite('ChatEditingChangeNavigation', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const current = URI.file('/workspace/current.ts');
	const other = URI.file('/workspace/other.ts');
	const viewport = [new Range(20, 1, 40, 1)];

	function entry(resource: URI, start: number, end: number) {
		return new class extends mock<IModifiedFileEntry>() {
			override readonly modifiedURI = resource;
			override readonly state = observableValue('state', ModifiedFileEntryState.Modified);
			override readonly changesCount = observableValue('changesCount', 1);
			override readonly diffInfo = observableValue<IDocumentDiff>('diff', {
				identical: false, quitEarly: false, moves: [],
				changes: [new DetailedLineRangeMapping(new LineRange(start, start + 1), new LineRange(start, end), undefined)],
			});
		};
	}

	function session(entries: readonly IModifiedFileEntry[], global = true): IChatEditReviewSession {
		return new class extends mock<IChatEditReviewSession>() {
			override readonly isGlobalEditingSession = global;
			override readonly entries = constObservable(entries);
		};
	}

	test('offers another file when the current file has no pending changes', () => {
		const changed = entry(other, 60, 65);
		const review = session([changed]);
		assert.deepStrictEqual(getChatEditingChangeNavigation([review], current, viewport, 100, undefined), { session: review, entry: changed, visible: false });
	});

	test('prefers the current file across sessions', () => {
		const changed = entry(current, 60, 65);
		const review = session([changed]);
		assert.deepStrictEqual(getChatEditingChangeNavigation([session([entry(other, 1, 2)]), review], current, viewport, 100, undefined), { session: review, entry: changed, visible: false });
	});

	for (const { name, start, end, visible } of [
		{ name: 'above viewport', start: 5, end: 10, visible: false },
		{ name: 'below viewport', start: 60, end: 65, visible: false },
		{ name: 'partially visible', start: 10, end: 21, visible: true },
		{ name: 'ends before viewport', start: 10, end: 20, visible: false },
		{ name: 'starts on bottom edge', start: 40, end: 45, visible: true },
		{ name: 'deletion in viewport', start: 30, end: 30, visible: true },
		{ name: 'deletion below viewport', start: 60, end: 60, visible: false },
	]) {
		test(name, () => {
			assert.strictEqual(getChatEditingChangeNavigation([session([entry(current, start, end)])], current, viewport, 100, undefined)?.visible, visible);
		});
	}

	test('deletion at end of file uses the last existing line', () => {
		assert.strictEqual(getChatEditingChangeNavigation([session([entry(current, 101, 101)])], current, [new Range(95, 1, 100, 1)], 100, undefined)?.visible, true);
	});

	test('hidden ranges do not count as visible changes', () => {
		assert.strictEqual(getChatEditingChangeNavigation([session([entry(current, 30, 35)])], current, [new Range(20, 1, 25, 1), new Range(36, 1, 40, 1)], 100, undefined)?.visible, false);
	});

	test('ignores inline sessions, settled entries and entries without changes', () => {
		const accepted = entry(other, 1, 2);
		accepted.state.set(ModifiedFileEntryState.Accepted, undefined);
		const rejected = entry(other, 1, 2);
		rejected.state.set(ModifiedFileEntryState.Rejected, undefined);
		const empty = entry(other, 1, 2);
		empty.changesCount.set(0, undefined);
		assert.strictEqual(getChatEditingChangeNavigation([session([entry(current, 60, 65)], false), session([accepted, rejected, empty])], current, viewport, 100, undefined), undefined);
	});

	test('updates when a visible change moves and when review is settled', () => {
		const changed = entry(current, 25, 30);
		const review = session([changed]);
		const states: (boolean | undefined)[] = [];
		store.add(autorun(reader => {
			states.push(getChatEditingChangeNavigation([review], current, viewport, 100, reader)?.visible);
		}));
		changed.diffInfo.set({ identical: false, quitEarly: false, moves: [], changes: [new DetailedLineRangeMapping(new LineRange(60, 61), new LineRange(60, 65), undefined)] }, undefined);
		changed.state.set(ModifiedFileEntryState.Accepted, undefined);
		assert.deepStrictEqual(states, [true, false, undefined]);
	});

	for (const settleWhileOpening of [false, true]) {
		test(settleWhileOpening ? 'does not reveal a change settled while opening' : 'opens the modified file in the originating group and reveals its first change', async () => {
			const calls: object[] = [];
			const changed = entry(other, 60, 65);
			const pane = new class extends mock<ITextDiffEditorPane>() { };
			changed.getEditorIntegration = editor => {
				assert.strictEqual(editor, pane);
				return new class extends mock<IModifiedFileEntryEditorIntegration>() {
					override reveal(first: boolean): void { calls.push({ first }); }
				};
			};
			const editorService = new class extends mock<IEditorService>() {
				override openEditor: IEditorService['openEditor'] = async (input, group) => {
					calls.push({ input, group });
					if (settleWhileOpening) {
						changed.state.set(ModifiedFileEntryState.Accepted, undefined);
					}
					return pane;
				};
			};
			await revealChatEditingChange({ session: session([changed]), entry: changed, visible: false }, editorService, 7);
			assert.deepStrictEqual(calls, [
				{ input: { resource: other, options: { revealIfOpened: false, revealIfVisible: false } }, group: 7 },
				...(settleWhileOpening ? [] : [{ first: true }]),
			]);
		});
	}
});
