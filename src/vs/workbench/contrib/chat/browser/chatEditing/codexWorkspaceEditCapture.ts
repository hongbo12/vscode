/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Limiter, RunOnceScheduler, Sequencer } from '../../../../../base/common/async.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ResourceMap, ResourceSet } from '../../../../../base/common/map.js';
import { isEqualOrParent } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { QueryBuilder } from '../../../../services/search/common/queryBuilder.js';
import { IFileQuery, ISearchService, SearchCompletionExitCode } from '../../../../services/search/common/search.js';
import { ITextFileService, TextFileOperationError, TextFileOperationResult } from '../../../../services/textfile/common/textfiles.js';
import { CodexExternalEditReviewSession } from './codexExternalEditReviewSession.js';

interface IWorkspaceCapture {
	readonly threadId: string;
	readonly session: CodexExternalEditReviewSession;
	readonly store: DisposableStore;
	readonly query: IFileQuery;
	readonly before: ResourceMap<string>;
	readonly lastSeen: ResourceMap<string | undefined>;
	readonly changed: ResourceSet;
	readonly binaryFiles: ResourceSet;
	readonly userEdited: ResourceSet;
	ready: boolean;
	revision: number;
}

/** Capture before dispatching a turn, independently of the tools the agent uses. */
export class CodexWorkspaceEditCapture extends Disposable {
	private readonly _sequencer = new Sequencer();
	private readonly _queryBuilder: QueryBuilder;
	private _active: IWorkspaceCapture | undefined;

	constructor(
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@ISearchService private readonly _search: ISearchService,
		@ITextFileService private readonly _textFiles: ITextFileService,
		@IFileService private readonly _files: IFileService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService private readonly _log: ILogService,
		@INotificationService private readonly _notifications: INotificationService,
	) {
		super();
		this._queryBuilder = instantiationService.createInstance(QueryBuilder);
	}

	begin(threadId: string, session: CodexExternalEditReviewSession): Promise<void> {
		return this._sequencer.queue(async () => {
			if (this._active || this._store.isDisposed) {
				throw new Error('Another Codex turn is already capturing this workspace, or the capture service is disposed.');
			}
			const folders = this._workspace.getWorkspace().folders;
			if (!folders.length) {
				throw new Error(localize('codexCaptureNoWorkspace', "Open a workspace before starting Codex edit review."));
			}
			const store = new DisposableStore();
			const capture: IWorkspaceCapture = {
				threadId, session, store, query: this._queryBuilder.file(folders, { _reason: 'codexEditReview', disregardIgnoreFiles: false }),
				before: new ResourceMap(), lastSeen: new ResourceMap(), changed: new ResourceSet(), binaryFiles: new ResourceSet(), userEdited: new ResourceSet(), ready: false, revision: 0,
			};
			this._active = capture;
			try {
				store.add(this._textFiles.files.onDidChangeDirty(model => {
					if (model.isDirty()) { capture.userEdited.add(model.resource); }
				}));
				for (const model of this._textFiles.files.models) {
					if (model.isDirty()) { capture.userEdited.add(model.resource); }
				}
				const refresh = store.add(new RunOnceScheduler(() => {
					void this._sequencer.queue(() => this._refresh(capture, false)).catch(error => this._reportError(error));
				}, 300));
				// File service supports correlated watchers only for non-recursive requests.
				for (const folder of folders) {
					store.add(this._files.watch(folder.uri, { recursive: true, excludes: ['**/.git/**', '**/node_modules/**'] }));
				}
				store.add(this._files.onDidFilesChange(event => {
					for (const resource of [...event.rawAdded, ...event.rawUpdated, ...event.rawDeleted]) {
						if (folders.some(folder => isEqualOrParent(resource, folder.uri))) { capture.changed.add(resource); }
					}
					if (capture.ready) { refresh.schedule(); }
				}));
				const resources = await this._list(capture.query);
				const limiter = store.add(new Limiter<void>(16));
				const results = await Promise.allSettled(resources.map(resource => limiter.queue(async () => {
					const content = await this._readText(resource);
					if (content !== undefined) {
						capture.before.set(resource, content);
						capture.lastSeen.set(resource, content);
					} else {
						capture.binaryFiles.add(resource);
					}
				})));
				for (const result of results) { if (result.status === 'rejected') { throw result.reason; } }
				// Watcher events can arrive after a save was already included in the snapshot,
				// or describe metadata/same-content writes. Verify content before rejecting it.
				while (capture.changed.size > 0 && !this._store.isDisposed) {
					const changedResources = [...capture.changed].filter(resource => capture.before.has(resource));
					capture.changed.clear();
					const verification = await Promise.allSettled(changedResources.map(resource => limiter.queue(async () => {
						if (await this._readText(resource) !== capture.before.get(resource)) {
							throw new Error(localize('codexCaptureChangedFile', "The contents of {0} changed while preparing the Codex review baseline. Save your changes before starting the turn again.", resource.fsPath));
						}
					})));
					for (const result of verification) { if (result.status === 'rejected') { throw result.reason; } }
					// Drain events received during verification against the same immutable baseline.
					// A content mismatch or read failure aborts immediately; neither is retried.
				}
				if (this._store.isDisposed || this._active !== capture) {
					throw new Error(localize('codexCaptureDisposed', "Workspace review was disposed while preparing the baseline."));
				}
				capture.ready = true;
				this._log.info(`[CodexReview] Captured ${capture.before.size} text files for ${threadId}`);
			} catch (error) {
				store.dispose();
				if (this._active === capture) { this._active = undefined; }
				this._reportError(error);
				throw error;
			}
		});
	}

	finish(threadId: string): Promise<void> {
		return this._sequencer.queue(async () => {
			const capture = this._active;
			if (!capture || capture.threadId !== threadId) { return; }
			try { await this._refresh(capture, true); }
			finally {
				capture.store.dispose();
				this._active = undefined;
			}
		});
	}

	private async _list(query: IFileQuery): Promise<URI[]> {
		const result = await this._search.fileSearch(query);
		if (result.limitHit) { throw new Error('Codex workspace snapshot file search was truncated.'); }
		if (result.exit !== undefined && result.exit !== SearchCompletionExitCode.Normal) { throw new Error('Codex workspace snapshot file search was interrupted.'); }
		return result.results.map(result => result.resource);
	}

	private async _readText(resource: URI): Promise<string | undefined> {
		try { return (await this._textFiles.read(resource, { acceptTextOnly: true })).value; }
		catch (error) {
			if (TextFileOperationError.isTextFileOperationError(error) && error.textFileOperationResult === TextFileOperationResult.FILE_IS_BINARY) { return undefined; }
			throw error;
		}
	}

	private async _refresh(capture: IWorkspaceCapture, final: boolean): Promise<void> {
		if (this._active !== capture || !capture.ready || this._store.isDisposed) { return; }
		// The final search includes new files and catches providers that coalesce watch events.
		const resources = final
			? new ResourceSet([...capture.before.keys(), ...capture.lastSeen.keys(), ...await this._list(capture.query)])
			: new ResourceSet([...capture.changed].filter(resource => capture.lastSeen.has(resource)));
		capture.changed.clear();
		const limiter = new Limiter<void>(16);
		try {
			const results = await Promise.allSettled([...resources].map(resource => limiter.queue(async () => {
				if (capture.binaryFiles.has(resource)) { return; }
				const exists = await this._files.exists(resource);
				const content = exists ? await this._readText(resource) : undefined;
				if ((exists && content === undefined) || (capture.lastSeen.has(resource) && capture.lastSeen.get(resource) === content)) { return; }
				if (capture.userEdited.has(resource)) {
					this._reportError(new Error(localize('codexCaptureUserEdit', "Your edits to {0} were preserved. Codex review cannot safely attribute this file's changes while you edit it.", resource.fsPath)));
					return;
				}
				if (this._active !== capture || this._store.isDisposed) { return; }
				const operationId = `workspace:${capture.threadId}:${++capture.revision}`;
				const baseline = !capture.session.getEntry(resource) && capture.lastSeen.has(resource) ? capture.lastSeen.get(resource) : capture.before.get(resource);
				await capture.session.begin(operationId, [{ resource, kind: exists ? 'update' : 'delete', snapshot: { content: baseline } }]);
				await capture.session.end(operationId);
				capture.lastSeen.set(resource, content);
			})));
			for (const result of results) { if (result.status === 'rejected') { throw result.reason; } }
		} finally { limiter.dispose(); }
	}

	private _reportError(error: unknown): void {
		this._log.error('Codex native edit review failed', error);
		this._notifications.error(error instanceof Error ? error : String(error));
	}

	override dispose(): void {
		this._active?.store.dispose();
		this._active = undefined;
		super.dispose();
	}
}
