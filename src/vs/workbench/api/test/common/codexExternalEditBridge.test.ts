/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ICodexExternalEdit, installCodexExternalEditBridge, resolveCodexEditResource } from '../../common/codexExternalEditBridge.js';

interface Message { id?: string | number; method?: string; params?: unknown; result?: unknown }

class TestAppServer {
	readonly messages: Message[] = [];
	readonly responses: { id: string | number; result: unknown }[] = [];
	readonly requests: { method: string; params: unknown }[] = [];
	handleIncomingMessage(message: Message): void { this.messages.push(message); }
	sendResponse(id: string | number, result: unknown): void { this.responses.push({ id, result }); }
	sendProviderRequest(_provider: string, _id: string, method: string, params: unknown, _prewarm: boolean, _delivery: boolean): void { this.requests.push({ method, params }); }
}

function change(method: string): Message {
	return { method, params: { threadId: 'thread', turnId: 'turn', item: {
		id: 'item', type: 'fileChange', status: method === 'item/started' ? 'inProgress' : 'completed',
		changes: [{ path: 'file.txt', kind: { type: 'update' } }],
	} } };
}
function approval(): Message {
	return { id: 42, method: 'item/fileChange/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'item' } };
}

suite('CodexExternalEditBridge', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
	function setupBridge(begin: (edit: ICodexExternalEdit) => Promise<void> = async () => { }) {
		const app = new TestAppServer();
		const errors: unknown[] = [];
		const ended: ICodexExternalEdit[] = [];
		const original = { receive: app.handleIncomingMessage, respond: app.sendResponse, request: app.sendProviderRequest };
		const disposable = store.add(installCodexExternalEditBridge({ conversationLoader: { codexAppServer: app } }, {
			begin, end: async edit => { ended.push(edit); }, onError: error => errors.push(error),
		}));
		return { app, errors, ended, disposable, original };
	}

	test('approval is displayed, but no response is sent until the user chooses', async () => {
		const f = setupBridge();
		f.app.handleIncomingMessage(change('item/started'));
		const request = approval();
		f.app.handleIncomingMessage(request);
		await flush();
		assert.deepStrictEqual({ request: f.app.messages.at(-1), responses: f.app.responses }, { request, responses: [] });
	});

	for (const decision of ['accept', 'acceptForSession']) {
		test(`waits for the snapshot before forwarding the user's ${decision}`, async () => {
			const gate = new DeferredPromise<void>();
			const f = setupBridge(() => gate.p);
			f.app.handleIncomingMessage(change('item/started'));
			f.app.handleIncomingMessage(approval());
			f.app.sendResponse(42, { decision });
			await flush();
			assert.deepStrictEqual(f.app.responses, []);
			await gate.complete();
			await flush();
			assert.deepStrictEqual(f.app.responses, [{ id: 42, result: { decision } }]);
		});
	}

	for (const decision of ['decline', 'cancel']) {
		test(`forwards ${decision} immediately while the snapshot is pending`, async () => {
			const gate = new DeferredPromise<void>();
			const f = setupBridge(() => gate.p);
			f.app.handleIncomingMessage(change('item/started'));
			f.app.handleIncomingMessage(approval());
			f.app.sendResponse(42, { decision });
			assert.deepStrictEqual(f.app.responses, [{ id: 42, result: { decision } }]);
			await gate.complete();
		});
	}

	test('snapshot failure cannot turn a user approval into a write', async () => {
		const failure = new Error('snapshot failed');
		const f = setupBridge(async () => { throw failure; });
		f.app.handleIncomingMessage(change('item/started'));
		f.app.handleIncomingMessage(approval());
		f.app.sendResponse(42, { decision: 'accept' });
		await flush();
		assert.deepStrictEqual({ errors: f.errors, responses: f.app.responses }, {
			errors: [failure], responses: [{ id: 42, result: { decision: 'decline' } }],
		});
	});

	test('unknown operations cannot be approved without a baseline', async () => {
		const f = setupBridge();
		f.app.handleIncomingMessage(approval());
		f.app.sendResponse(42, { decision: 'accept' });
		await flush();
		assert.deepStrictEqual({ errors: f.errors.length, responses: f.app.responses }, {
			errors: 1, responses: [{ id: 42, result: { decision: 'decline' } }],
		});
	});

	test('preserves the configured approval policy and tracks the thread working directory', async () => {
		const started: ICodexExternalEdit[] = [];
		const f = setupBridge(async edit => { started.push(edit); });
		const params = { threadId: 'thread', cwd: '/workspace/second', approvalPolicy: 'never' };
		f.app.sendProviderRequest('provider', 'request', 'turn/start', params, false, false);
		f.app.handleIncomingMessage(change('item/started'));
		await flush();
		assert.deepStrictEqual({ requests: f.app.requests, path: resolveCodexEditResource(started[0].changes[0].path, started[0].cwd).path }, {
			requests: [{ method: 'turn/start', params }], path: '/workspace/second/file.txt',
		});
	});

	test('relative resources require their own working directory', () => {
		assert.throws(() => resolveCodexEditResource('file.txt', undefined), /working directory/);
	});

	test('workspace baseline completes before the plugin dispatches any turn tools', async () => {
		const gate = new DeferredPromise<void>();
		const app = new TestAppServer();
		const finished: string[] = [];
		const errors: unknown[] = [];
		store.add(installCodexExternalEditBridge({ conversationLoader: { codexAppServer: app } }, {
			begin: async () => { throw new Error('Per-file capture must not race with workspace capture'); }, end: async () => { },
			beginTurn: () => gate.p, endTurn: async id => { finished.push(id); }, onError: error => errors.push(error),
		}));
		const params = { threadId: 'thread', approvalPolicy: 'on-request' };
		app.sendProviderRequest('provider', '1', 'turn/start', params, false, false);
		await flush();
		assert.deepStrictEqual(app.requests, []);
		await gate.complete();
		await flush();
		app.handleIncomingMessage({ method: 'item/completed', params: { threadId: 'thread', item: { type: 'dynamicToolCall', tool: 'exec' } } });
		app.handleIncomingMessage(change('item/started'));
		app.handleIncomingMessage(approval());
		app.sendResponse(42, { decision: 'decline' });
		app.handleIncomingMessage({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn' } } });
		await flush();
		assert.deepStrictEqual({ requests: app.requests, responses: app.responses, finished, errors }, {
			requests: [{ method: 'turn/start', params }], responses: [{ id: 42, result: { decision: 'decline' } }], finished: ['thread'], errors: [],
		});
	});

	test('failed workspace capture never dispatches the turn and returns an error to the plugin', async () => {
		const app = new TestAppServer();
		const errors: unknown[] = [];
		store.add(installCodexExternalEditBridge({ conversationLoader: { codexAppServer: app } }, {
			begin: async () => { }, end: async () => { },
			beginTurn: async () => { throw new Error('cannot snapshot'); }, endTurn: async () => { }, onError: error => errors.push(error),
		}));
		app.sendProviderRequest('provider', '1', 'turn/start', { threadId: 'thread' }, false, false);
		await flush();
		assert.deepStrictEqual({ requests: app.requests, resultId: app.messages[0].id, errors: errors.length }, { requests: [], resultId: 'provider:1', errors: 1 });
	});

	test('duplicate start and completion messages do not duplicate a review operation', async () => {
		let started = 0;
		const f = setupBridge(async () => { started++; });
		for (const method of ['item/started', 'item/started', 'item/completed', 'item/completed']) {
			f.app.handleIncomingMessage(change(method));
		}
		await flush();
		assert.deepStrictEqual({ started, ended: f.ended.length }, { started: 1, ended: 1 });
	});

	test('turn completion releases edits missing an item completion', async () => {
		const f = setupBridge();
		f.app.handleIncomingMessage(change('item/started'));
		f.app.handleIncomingMessage({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn' } } });
		await flush();
		assert.deepStrictEqual(f.ended.map(edit => edit.status), ['unknown']);
	});

	test('disposal cancels a queued approval and restores the connection', async () => {
		const gate = new DeferredPromise<void>();
		const f = setupBridge(() => gate.p);
		f.app.handleIncomingMessage(change('item/started'));
		f.app.handleIncomingMessage(approval());
		f.app.sendResponse(42, { decision: 'accept' });
		f.disposable.dispose();
		await gate.complete();
		await flush();
		assert.deepStrictEqual({ receive: f.app.handleIncomingMessage, respond: f.app.sendResponse, request: f.app.sendProviderRequest, responses: f.app.responses }, {
			...f.original, responses: [],
		});
	});
});
