/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IReader } from '../../../../../base/common/observable.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IRange } from '../../../../../editor/common/core/range.js';
import { IResourceEditorInput } from '../../../../../platform/editor/common/editor.js';
import { IResourceDiffEditorInput } from '../../../../common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IChatEditReviewSession, IModifiedFileEntry, ModifiedFileEntryState } from '../../common/editing/chatEditingService.js';

/** Resolve virtual deletion previews to their review entry for toolbar actions and context keys. */
export function getChatEditingEntryForResource(session: IChatEditReviewSession, resource: URI, reader?: IReader): IModifiedFileEntry | undefined {
	return (reader ? session.readEntry(resource, reader) : session.getEntry(resource))
		?? session.entries.read(reader).find(entry => entry.isDeletion &&
			(isEqual(entry.modifiedModelURI, resource) || isEqual(entry.originalURI, resource)));
}

/** Deleted files are reviewed against an empty virtual model, never the missing disk resource. */
export function getChatEditingReviewEditorInput(entry: IModifiedFileEntry): IResourceEditorInput | IResourceDiffEditorInput {
	const options = { revealIfOpened: false, revealIfVisible: false };
	if (entry.isDeletion && entry.modifiedModelURI) {
		return { original: { resource: entry.originalURI }, modified: { resource: entry.modifiedModelURI }, options };
	}
	return { resource: entry.modifiedURI, options };
}

/** Select a pending change, preferring the current file, and check whether it is on screen. */
export function getChatEditingChangeNavigation(
	sessions: readonly IChatEditReviewSession[],
	resource: URI,
	visibleRanges: readonly IRange[],
	lineCount: number,
	reader: IReader | undefined,
): { session: IChatEditReviewSession; entry: IModifiedFileEntry; visible: boolean } | undefined {
	let first: { session: IChatEditReviewSession; entry: IModifiedFileEntry; visible: boolean } | undefined;
	for (const session of sessions) {
		if (!session.isGlobalEditingSession) {
			continue;
		}
		for (const entry of session.entries.read(reader)) {
			if (entry.state.read(reader) !== ModifiedFileEntryState.Modified || entry.changesCount.read(reader) === 0) {
				continue;
			}
			first ??= { session, entry, visible: false };
			if (isEqual(entry.modifiedURI, resource) || isEqual(entry.modifiedModelURI, resource)) {
				const changes = entry.diffInfo?.read(reader).changes;
				const visible = changes?.some(change => {
					// A deletion has no modified lines; its decoration is anchored to the next line.
					const start = Math.min(change.modified.startLineNumber, lineCount);
					const end = Math.min(Math.max(change.modified.startLineNumber, change.modified.endLineNumberExclusive - 1), lineCount);
					return visibleRanges.some(range => range.startLineNumber <= end && range.endLineNumber >= start);
				}) ?? false;
				return { session, entry, visible };
			}
		}
	}
	return first;
}

/** Open the target in the originating group and use the entry's existing hunk navigation. */
export async function revealChatEditingChange(
	target: NonNullable<ReturnType<typeof getChatEditingChangeNavigation>>,
	editorService: IEditorService,
	groupId: number,
	first = true,
): Promise<boolean> {
	const isPending = () => target.session.entries.get().includes(target.entry)
		&& target.entry.state.get() === ModifiedFileEntryState.Modified
		&& target.entry.changesCount.get() > 0;
	if (!isPending()) {
		return false;
	}
	const pane = await editorService.openEditor(getChatEditingReviewEditorInput(target.entry), groupId);
	if (pane && isPending()) {
		target.entry.getEditorIntegration(pane).reveal(first);
	}
	return !!pane;
}
