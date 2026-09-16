/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { EditOperation } from '../../../../../editor/common/core/editOperation.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { IDocumentDiffProviderOptions } from '../../../../../editor/common/diff/documentDiffProvider.js';
import { linesDiffComputers } from '../../../../../editor/common/diff/linesDiffComputers.js';
import { IEditorWorkerService } from '../../../../../editor/common/services/editorWorker.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { EditSources } from '../../../../../editor/common/textModelEditSource.js';
import { TestEditorWorkerService } from '../../../../../editor/test/common/services/testEditorWorkerService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IWorkspaceContextService, Workspace, toWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { IAiEditTelemetryService } from '../../../editTelemetry/browser/telemetry/aiEditTelemetry/aiEditTelemetryService.js';
import { ChatEditingDeletedFileEntry } from '../../browser/chatEditing/chatEditingDeletedFileEntry.js';
import { ChatEditingModifiedDocumentEntry } from '../../browser/chatEditing/chatEditingModifiedDocumentEntry.js';
import { ChatEditingTextModelContentProvider } from '../../browser/chatEditing/chatEditingTextModelContentProviders.js';
import { CodexExternalEditReviewSession } from '../../browser/chatEditing/codexExternalEditReviewSession.js';
import { CodexWorkspaceEditCapture } from '../../browser/chatEditing/codexWorkspaceEditCapture.js';
import { IChatService } from '../../common/chatService/chatService.js';

suite('CodexExternalEditReviewSession', () => {
	const store = new DisposableStore();
	let insta: TestInstantiationService;
	let files: IFileService;
	let textFiles: ITextFileService;
	let session: CodexExternalEditReviewSession;
	let errors: string[];
	const resource = URI.file('/workspace/file.txt');

	setup(async () => {
		errors = [];
		files = store.add(new FileService(new NullLogService()));
		store.add(files.registerProvider('file', store.add(new InMemoryFileSystemProvider())));
		insta = workbenchInstantiationService({ fileService: () => files }, store);
		insta.stub(IEditorWorkerService, new class extends TestEditorWorkerService {
			override async computeDiff(original: URI, modified: URI, options: IDocumentDiffProviderOptions) {
				const originalModel = insta.get(IModelService).getModel(original);
				const modifiedModel = insta.get(IModelService).getModel(modified);
				if (!originalModel || !modifiedModel) {
					return null;
				}
				const result = linesDiffComputers.getDefault().computeDiff(originalModel.getLinesContent(), modifiedModel.getLinesContent(), options);
				return { changes: result.changes, moves: result.moves, quitEarly: result.hitTimeout, identical: originalModel.getValue() === modifiedModel.getValue() };
			}
		});
		insta.stub(IChatService, new class extends mock<IChatService>() {
			override notifyUserAction(): void { }
		});
		insta.stub(IAiEditTelemetryService, new class extends mock<IAiEditTelemetryService>() {
			override handleCodeAccepted(): void { }
			override handleCodeRejected(): void { }
		});
		insta.stub(INotificationService, new class extends TestNotificationService {
			override error(error: string | Error) {
				errors.push(String(error));
				return super.error(error);
			}
		});
		textFiles = insta.get(ITextFileService);
		store.add(insta.get(ITextModelService).registerTextModelContentProvider(ChatEditingTextModelContentProvider.scheme, {
			provideTextContent: async uri => insta.get(IModelService).getModel(uri),
		}));
		session = store.add(insta.createInstance(CodexExternalEditReviewSession, URI.parse('openai-codex-review:/one')));
		await files.createFolder(URI.file('/workspace'));
	});

	teardown(async () => {
		for (const model of textFiles.files.models) {
			await model.revert({ soft: true });
		}
		session.dispose();
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		store.clear();
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	});
	ensureNoDisposablesAreLeakedInTestSuite();

	async function write(value: string): Promise<void> {
		await files.writeFile(resource, VSBuffer.fromString(value));
	}
	async function read(): Promise<string> {
		return (await files.readFile(resource)).value.toString();
	}
	function documentEntry(): ChatEditingModifiedDocumentEntry {
		const entry = session.getEntry(resource);
		assert.ok(entry instanceof ChatEditingModifiedDocumentEntry);
		return entry;
	}
	async function update(operationId: string, value: string): Promise<void> {
		await session.begin(operationId, [{ resource, kind: 'update' }]);
		await write(value);
		await session.end(operationId);
	}
	async function captureWorkspace(resources: URI[] = [resource]): Promise<CodexWorkspaceEditCapture> {
		insta.stub(IWorkspaceContextService, new TestContextService(new Workspace('capture', [toWorkspaceFolder(URI.file('/workspace'))], false, null, () => false)));
		insta.stub(ISearchService, new class extends mock<ISearchService>() {
			override async fileSearch() { return { results: resources.map(resource => ({ resource })), messages: [] }; }
		});
		// Drain the in-memory provider's batched setup notifications before taking a baseline.
		await new Promise<void>(resolve => setTimeout(resolve, 10));
		const capture = store.add(insta.createInstance(CodexWorkspaceEditCapture));
		await capture.begin('thread', session);
		return capture;
	}

	test('workspace capture exposes native diff hunks for a shell write without fileChange events', async () => {
		await write('before\n');
		const capture = await captureWorkspace();
		await write('after\n');
		await capture.finish('thread');
		const entry = documentEntry();
		await new Promise<void>(resolve => {
			const observer = autorun(reader => { if (entry.diffInfo.read(reader).changes.length) { resolve(); } });
			store.add(observer);
		});
		assert.deepStrictEqual({ original: entry.originalModel.getValue(), current: entry.modifiedModel.getValue(), review: entry.reviewMode.get(), errors }, {
			original: 'before\n', current: 'after\n', review: true, errors: [],
		});
		await session.reject(resource);
		assert.strictEqual(await read(), 'before\n');
	});

	test('workspace capture discovers new files and rejects their creation', async () => {
		const resources: URI[] = [];
		const capture = await captureWorkspace(resources);
		await write('new\n');
		resources.push(resource);
		await capture.finish('thread');
		await session.reject(resource);
		assert.strictEqual(await files.exists(resource), false);
	});

	test('workspace capture does not misclassify an existing binary file as newly created text', async () => {
		await files.writeFile(resource, VSBuffer.wrap(new Uint8Array([0, 0, 1, 2])));
		const capture = await captureWorkspace();
		await write('converted to text');
		await capture.finish('thread');
		assert.deepStrictEqual({ pending: !!session.getEntry(resource), exists: await files.exists(resource), errors }, { pending: false, exists: true, errors: [] });
	});

	test('workspace capture watches a file while a plugin turn is still executing', async () => {
		await write('before\n');
		const capture = await captureWorkspace();
		await write('changed while running\n');
		await new Promise<void>(resolve => {
			store.add(autorun(reader => { if (session.entries.read(reader).length) { resolve(); } }));
		});
		await capture.finish('thread');
		assert.deepStrictEqual({ original: documentEntry().originalModel.getValue(), changed: documentEntry().modifiedModel.getValue() }, {
			original: 'before\n', changed: 'changed while running\n',
		});
	});

	test('workspace capture restores files deleted by an arbitrary tool', async () => {
		await write('before deletion\n');
		const resources = [resource];
		const capture = await captureWorkspace(resources);
		await files.del(resource);
		resources.length = 0;
		await capture.finish('thread');
		await session.reject(resource);
		assert.strictEqual(await read(), 'before deletion\n');
	});

	test('workspace capture preserves manual typing and reports an attribution conflict', async () => {
		await write('before\n');
		const capture = await captureWorkspace();
		const ref = store.add(await insta.get(ITextModelService).createModelReference(resource));
		ref.object.textEditorModel.setValue('manual\n');
		await write('agent\n');
		await capture.finish('thread');
		assert.deepStrictEqual({ content: ref.object.textEditorModel.getValue(), pending: session.getEntry(resource), errors: errors.length }, {
			content: 'manual\n', pending: undefined, errors: 1,
		});
	});

	test('workspace capture ignores unchanged files and excludes unrelated search results', async () => {
		await write('unchanged\n');
		const capture = await captureWorkspace();
		await files.writeFile(URI.file('/workspace/ignored.txt'), VSBuffer.fromString('ignored'));
		await capture.finish('thread');
		assert.deepStrictEqual({ entries: session.entries.get().length, errors }, { entries: 0, errors: [] });
	});

	test('workspace capture rejects overlapping turns instead of misattributing writes', async () => {
		await write('before\n');
		const capture = await captureWorkspace();
		await assert.rejects(capture.begin('other-thread', session), /already capturing/);
		await capture.finish('thread');
	});

	test('reject restores actual model and disk content', async () => {
		await write('original\n');
		await update('update', 'changed\n');
		await session.reject(resource);
		assert.deepStrictEqual({ disk: await read(), pending: session.getEntry(resource), errors }, { disk: 'original\n', pending: undefined, errors: [] });
	});

	test('keeps a new baseline after accepting a previous edit', async () => {
		await write('original\n');
		await update('one', 'accepted\n');
		await session.accept(resource);
		await update('two', 'pending\n');
		await session.reject(resource);
		assert.strictEqual(await read(), 'accepted\n');
	});

	test('reject deletes a new file after multiple external edits', async () => {
		await session.begin('create', [{ resource, kind: 'add' }]);
		await write('created\n');
		await session.end('create');
		await update('update', 'updated\n');
		await session.reject(resource);
		assert.deepStrictEqual({ exists: await files.exists(resource), errors }, { exists: false, errors: [] });
	});

	test('update then delete restores the original file when rejected', async () => {
		await write('original\n');
		await update('update', 'changed\n');
		await session.begin('delete', [{ resource, kind: 'delete' }]);
		await files.del(resource);
		await session.end('delete');
		assert.ok(session.getEntry(resource) instanceof ChatEditingDeletedFileEntry);
		await session.reject(resource);
		assert.deepStrictEqual({ disk: await read(), errors }, { disk: 'original\n', errors: [] });
	});

	test('delete then recreate switches back to a document entry and restores the baseline', async () => {
		await write('original\n');
		await session.begin('delete', [{ resource, kind: 'delete' }]);
		await files.del(resource);
		await session.end('delete');
		await session.begin('create', [{ resource, kind: 'add' }]);
		await write('replacement\n');
		await session.end('create');
		assert.strictEqual(documentEntry().originalModel.getValue(), 'original\n');
		await session.reject(resource);
		assert.strictEqual(await read(), 'original\n');
	});

	test('create then delete has no remaining review entry', async () => {
		await session.begin('create', [{ resource, kind: 'add' }]);
		await write('created\n');
		await session.end('create');
		await session.begin('delete', [{ resource, kind: 'delete' }]);
		await files.del(resource);
		await session.end('delete');
		assert.deepStrictEqual({ entries: session.entries.get().length, exists: await files.exists(resource) }, { entries: 0, exists: false });
	});

	test('rename restores the source and removes the target on reject', async () => {
		const target = URI.file('/workspace/renamed.txt');
		await write('original\n');
		await session.begin('move', [{ resource, kind: 'delete' }, { resource: target, kind: 'add' }]);
		await files.move(resource, target);
		await session.end('move');
		await session.reject();
		assert.deepStrictEqual({ source: await read(), targetExists: await files.exists(target), errors }, { source: 'original\n', targetExists: false, errors: [] });
	});

	test('dirty buffers are preserved and baseline preparation is rejected', async () => {
		await write('disk\n');
		const ref = store.add(await insta.get(ITextModelService).createModelReference(resource));
		ref.object.textEditorModel.setValue('unsaved\n');
		await assert.rejects(session.begin('update', [{ resource, kind: 'update' }]), /Unsaved changes/);
		assert.deepStrictEqual({ disk: await read(), model: ref.object.textEditorModel.getValue(), dirty: textFiles.isDirty(resource), entries: session.entries.get().length },
			{ disk: 'disk\n', model: 'unsaved\n', dirty: true, entries: 0 });
	});

	test('typing during an external edit is not reloaded or attributed to the agent', async () => {
		await write('original\n');
		await session.begin('update', [{ resource, kind: 'update' }]);
		const entry = documentEntry();
		entry.modifiedModel.pushEditOperations(null, [EditOperation.insert(new Position(1, 1), 'user ')], () => null, undefined, EditSources.unknown({ name: 'user-test' }));
		await write('agent\n');
		await session.end('update');
		assert.deepStrictEqual({ disk: await read(), model: entry.modifiedModel.getValue(), original: entry.originalModel.getValue(), dirty: textFiles.isDirty(resource), notified: errors.length > 0 },
			{ disk: 'agent\n', model: 'user original\n', original: 'user original\n', dirty: true, notified: true });
	});

	test('failure on a later resource publishes nothing and does not classify later typing as external', async () => {
		await write('original\n');
		const second = URI.file('/workspace/broken.txt');
		await files.writeFile(second, VSBuffer.fromString('second'));
		const service = insta.get(ITextModelService);
		const original = service.createModelReference.bind(service);
		service.createModelReference = async uri => {
			if (uri.toString() === second.toString()) {
				throw new Error('baseline failure');
			}
			return original(uri);
		};
		try {
			await assert.rejects(session.begin('failed', [{ resource, kind: 'update' }, { resource: second, kind: 'update' }]), /baseline failure/);
			await session.end('failed');
			assert.strictEqual(session.entries.get().length, 0);
		} finally {
			service.createModelReference = original;
		}
		await update('retry', 'changed\n');
		await session.reject(resource);
		assert.strictEqual(await read(), 'original\n');
	});

	test('an accepted entry no longer shadows an older pending session', async () => {
		await write('original\n');
		await update('one', 'first\n');
		const other = store.add(insta.createInstance(CodexExternalEditReviewSession, URI.parse('openai-codex-review:/two')));
		await other.begin('two', [{ resource, kind: 'update' }]);
		await write('second\n');
		await other.end('two');
		await other.accept(resource);
		let selected: CodexExternalEditReviewSession | undefined;
		store.add(autorun(reader => {
			selected = [other, session].find(candidate => candidate.readEntry(resource, reader));
		}));
		assert.strictEqual(selected, session);
	});

	test('review is blocked while an external write is active', async () => {
		await write('original\n');
		await session.begin('update', [{ resource, kind: 'update' }]);
		await assert.rejects(session.reject(resource), /in progress/);
		await session.end('update');
	});

	test('overlapping operations keep tracking until the final completion', async () => {
		await write('original\n');
		await session.begin('one', [{ resource, kind: 'update' }]);
		await session.begin('two', [{ resource, kind: 'update' }]);
		await write('changed\n');
		await session.end('one');
		await assert.rejects(session.accept(resource), /in progress/);
		await session.end('two');
		await session.reject(resource);
		assert.strictEqual(await read(), 'original\n');
	});
});
