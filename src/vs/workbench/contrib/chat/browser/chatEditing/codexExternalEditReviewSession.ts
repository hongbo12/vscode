/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { IObservable, IReader, observableValue } from '../../../../../base/common/observable.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { ChatEditKind, IChatEditReviewSession, IModifiedEntryTelemetryInfo, IModifiedFileEntry, ModifiedFileEntryState } from '../../common/editing/chatEditingService.js';
import { ChatEditingDeletedFileEntry } from './chatEditingDeletedFileEntry.js';
import { ChatEditingModifiedDocumentEntry } from './chatEditingModifiedDocumentEntry.js';

export type CodexExternalEditKind = 'add' | 'delete' | 'update';
export interface ICodexExternalEditResource {
	readonly resource: URI;
	readonly kind: CodexExternalEditKind;
	/** A pre-turn baseline, captured before an arbitrary tool writes to disk. */
	readonly snapshot?: { readonly content: string | undefined };
}
type CodexExternalEditEntry = ChatEditingModifiedDocumentEntry | ChatEditingDeletedFileEntry;
interface IReviewBaseline {
	readonly operationId: string;
	readonly existed: boolean;
	readonly initialContent: string;
	readonly languageId: string;
}

/** Maintains the cumulative native review baseline until a file is accepted or rejected. */
export class CodexExternalEditReviewSession extends Disposable implements IChatEditReviewSession {
	readonly isGlobalEditingSession = true;
	private readonly _entries = new ResourceMap<CodexExternalEditEntry>();
	private readonly _entriesObservable = observableValue<readonly IModifiedFileEntry[]>(this, []);
	readonly entries: IObservable<readonly IModifiedFileEntry[]> = this._entriesObservable;
	private readonly _baselines = new ResourceMap<IReviewBaseline>();
	private readonly _operations = new Map<string, readonly ICodexExternalEditResource[]>();
	private readonly _sequencer = new Sequencer();
	private readonly _onDidDispose = this._register(new Emitter<void>());
	readonly onDidDispose = this._onDidDispose.event;

	constructor(
		readonly chatSessionResource: URI,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
	}

	begin(operationId: string, edits: readonly ICodexExternalEditResource[]): Promise<void> {
		return this._sequencer.queue(async () => {
			if (this._store.isDisposed || this._operations.has(operationId)) {
				return;
			}
			const uniqueEdits = [...new ResourceMap(edits.map(edit => [edit.resource, edit] as const)).values()];
			const staged = new ResourceMap<{ baseline: IReviewBaseline; entry?: CodexExternalEditEntry }>();
			const created: CodexExternalEditEntry[] = [];
			try {
				// Prepare every baseline before publishing or marking any entry as externally edited.
				for (const { resource, kind, snapshot } of uniqueEdits) {
					this._assertClean(resource);
					const oldEntry = this._entries.get(resource);
					const pending = oldEntry?.state.get() === ModifiedFileEntryState.Modified;
					const exists = await this._fileService.exists(resource);
					let baseline = pending || this._isResourceActive(resource) ? this._baselines.get(resource) : undefined;
					if (baseline && oldEntry instanceof ChatEditingModifiedDocumentEntry) {
						baseline = { ...baseline, initialContent: oldEntry.originalModel.getValue() };
					}
					if (!baseline) {
						let initialContent = '';
						let languageId = 'plaintext';
						if (exists) {
							const reference = await this._textModelService.createModelReference(resource);
							try {
								initialContent = reference.object.textEditorModel.getValue();
								languageId = reference.object.textEditorModel.getLanguageId();
							} finally {
								reference.dispose();
							}
						}
						baseline = snapshot
							? { operationId, existed: snapshot.content !== undefined, initialContent: snapshot.content ?? '', languageId }
							: { operationId, existed: exists, initialContent, languageId };
					}
					let entry = pending ? oldEntry : undefined;
					if (!entry && exists && kind !== 'delete') {
						entry = await this._createDocumentEntry(resource, baseline);
						created.push(entry);
					}
					staged.set(resource, { baseline, entry });
				}
				if (this._store.isDisposed) {
					return;
				}
				for (const { resource } of uniqueEdits) {
					this._assertClean(resource);
				}
				for (const [resource, { baseline, entry }] of staged) {
					this._replaceEntry(resource, entry);
					this._baselines.set(resource, baseline);
					entry?.startExternalEdit(true);
				}
				this._operations.set(operationId, uniqueEdits);
				created.length = 0;
				this._publishEntries();
			} catch (error) {
				this._reportError(error);
				throw error;
			} finally {
				for (const entry of created) {
					entry.dispose();
				}
			}
		});
	}

	end(operationId: string): Promise<void> {
		return this._sequencer.queue(async () => {
			const edits = this._operations.get(operationId);
			if (!edits || this._store.isDisposed) {
				return;
			}
			this._operations.delete(operationId);
			for (const { resource } of edits) {
				if (this._isResourceActive(resource)) {
					continue;
				}
				try {
					this._assertClean(resource);
					const baseline = this._baselines.get(resource);
					if (!baseline) {
						continue;
					}
					const exists = await this._fileService.exists(resource);
					this._assertClean(resource);
					if (this._store.isDisposed) {
						return;
					}
					let entry = this._entries.get(resource);
					if (!exists && !baseline.existed) {
						this._replaceEntry(resource, undefined);
						this._baselines.delete(resource);
						continue;
					}
					if (!exists && !(entry instanceof ChatEditingDeletedFileEntry)) {
						const initialContent = entry instanceof ChatEditingModifiedDocumentEntry ? entry.originalModel.getValue() : baseline.initialContent;
						entry = this._instantiationService.createInstance(ChatEditingDeletedFileEntry, resource, initialContent,
							{ collapse: () => { } }, this._getTelemetryInfo(baseline.operationId), baseline.languageId);
						this._replaceEntry(resource, entry);
						this._baselines.set(resource, { ...baseline, initialContent });
					} else if (exists) {
						if (!(entry instanceof ChatEditingModifiedDocumentEntry)) {
							const replacement = await this._createDocumentEntry(resource, baseline);
							if (this._store.isDisposed) {
								replacement.dispose();
								return;
							}
							entry = replacement;
							this._replaceEntry(resource, entry);
						}
						entry.startExternalEdit(true);
						await entry.revertToDisk(true);
					}
				} catch (error) {
					this._reportError(error);
				} finally {
					this._entries.get(resource)?.stopExternalEdit();
				}
			}
			this._publishEntries();
		});
	}

	getEntry(uri: URI): IModifiedFileEntry | undefined {
		const entry = this._entries.get(uri);
		return entry?.state.get() === ModifiedFileEntryState.Modified ? entry : undefined;
	}

	readEntry(uri: URI, reader: IReader): IModifiedFileEntry | undefined {
		this._entriesObservable.read(reader);
		const entry = this._entries.get(uri);
		return entry?.state.read(reader) === ModifiedFileEntryState.Modified ? entry : undefined;
	}

	accept(...uris: URI[]): Promise<void> {
		return this._review(true, uris);
	}

	reject(...uris: URI[]): Promise<void> {
		return this._review(false, uris);
	}

	private _review(accept: boolean, uris: readonly URI[]): Promise<void> {
		return this._sequencer.queue(async () => {
			const entries = [...this._entries.values()].filter(entry => entry.state.get() === ModifiedFileEntryState.Modified &&
				(uris.length === 0 || uris.some(uri => isEqual(uri, entry.modifiedURI))));
			if (entries.some(entry => this._isResourceActive(entry.modifiedURI))) {
				throw new Error('Cannot review a file while an external edit is in progress.');
			}
			for (const entry of entries) {
				await (accept ? entry.accept() : entry.reject());
			}
		});
	}

	override dispose(): void {
		if (this._store.isDisposed) {
			return;
		}
		this._onDidDispose.fire();
		for (const entry of this._entries.values()) {
			entry.stopExternalEdit();
			entry.dispose();
		}
		this._entries.clear();
		this._operations.clear();
		this._baselines.clear();
		this._publishEntries();
		super.dispose();
	}

	private _assertClean(resource: URI): void {
		if (this._textFileService.isDirty(resource)) {
			throw new Error(localize('codexReviewUnsaved', "Unsaved changes in {0} were preserved. Save or resolve them before reviewing external edits.", resource.fsPath));
		}
	}

	private _reportError(error: unknown): void {
		this._logService.error('Codex native edit review failed', error);
		this._notificationService.error(error instanceof Error ? error : String(error));
	}

	private async _createDocumentEntry(resource: URI, baseline: IReviewBaseline): Promise<ChatEditingModifiedDocumentEntry> {
		const reference = await this._textModelService.createModelReference(resource);
		try {
			return this._instantiationService.createInstance(ChatEditingModifiedDocumentEntry, reference, { collapse: () => { } },
				this._getTelemetryInfo(baseline.operationId), baseline.existed ? ChatEditKind.Modified : ChatEditKind.Created, baseline.initialContent);
		} catch (error) {
			reference.dispose();
			throw error;
		}
	}

	private _replaceEntry(resource: URI, entry: CodexExternalEditEntry | undefined): void {
		const previous = this._entries.get(resource);
		if (previous === entry) {
			return;
		}
		previous?.stopExternalEdit();
		previous?.dispose();
		if (entry) {
			entry.enableReviewModeUntilSettled();
			this._entries.set(resource, entry);
		} else {
			this._entries.delete(resource);
		}
	}

	private _publishEntries(): void {
		this._entriesObservable.set([...this._entries.values()], undefined);
	}

	private _isResourceActive(resource: URI): boolean {
		return [...this._operations.values()].some(edits => edits.some(edit => isEqual(edit.resource, resource)));
	}

	private _getTelemetryInfo(operationId: string): IModifiedEntryTelemetryInfo {
		return {
			agentId: 'openai-codex', command: undefined, sessionResource: this.chatSessionResource,
			requestId: operationId, result: undefined, modelId: undefined, modeId: 'agent',
			applyCodeBlockSuggestionId: undefined, feature: 'sideBarChat',
		};
	}
}
