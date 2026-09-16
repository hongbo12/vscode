/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { isAbsolute } from '../../../base/common/path.js';
import { joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';

export type CodexExternalEditStatus = 'inProgress' | 'completed' | 'failed' | 'declined' | 'unknown';
export type CodexExternalFileChangeKind = 'add' | 'delete' | 'update';

export interface ICodexExternalFileChange {
	readonly path: string;
	readonly kind: CodexExternalFileChangeKind;
	readonly movePath?: string;
}

export interface ICodexExternalEdit {
	readonly operationId: string;
	readonly threadId: string;
	readonly turnId: string;
	readonly itemId: string;
	readonly changes: readonly ICodexExternalFileChange[];
	readonly paths: readonly string[];
	readonly status: CodexExternalEditStatus;
	readonly cwd?: string;
}

export interface ICodexExternalEditLifecycle {
	begin(edit: ICodexExternalEdit): Promise<void>;
	end(edit: ICodexExternalEdit): Promise<void>;
	beginTurn?(threadId: string): Promise<void>;
	endTurn?(threadId: string): Promise<void>;
	onError(error: unknown): void;
}

// These values cross the third-party extension boundary and must be validated.
interface ICodexMessage {
	readonly id?: string | number;
	readonly method?: string;
	readonly params?: unknown;
	readonly result?: unknown;
	readonly error?: { readonly code: number; readonly message: string };
}

interface ICodexAppServer {
	handleIncomingMessage(message: ICodexMessage): unknown;
	sendResponse(id: string | number, result: unknown): void;
	sendProviderRequest(providerName: string, requestId: string, method: string, params: unknown, isPrewarm: boolean, trackDelivery: boolean): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getAppServer(provider: object): ICodexAppServer {
	const loader = isRecord(provider) ? provider.conversationLoader : undefined;
	const server = isRecord(loader) ? loader.codexAppServer : undefined;
	if (!isRecord(server) || typeof server.handleIncomingMessage !== 'function' || typeof server.sendResponse !== 'function' || typeof server.sendProviderRequest !== 'function') {
		throw new Error('Codex native edit review requires a compatible chat session provider.');
	}
	return server as unknown as ICodexAppServer;
}

function getFileChange(message: ICodexMessage): ICodexExternalEdit | undefined {
	if (message.method !== 'item/started' && message.method !== 'item/completed') {
		return undefined;
	}
	const params = message.params;
	if (!isRecord(params) || typeof params.threadId !== 'string' || typeof params.turnId !== 'string' || !isRecord(params.item)) {
		return undefined;
	}
	const item = params.item;
	if (item.type !== 'fileChange' || typeof item.id !== 'string' || !Array.isArray(item.changes)) {
		return undefined;
	}
	const changes: ICodexExternalFileChange[] = [];
	for (const change of item.changes) {
		if (!isRecord(change) || typeof change.path !== 'string') {
			throw new Error('Codex file change is missing its path.');
		}
		const kind = isRecord(change.kind) ? change.kind.type : change.kind;
		if (kind !== 'add' && kind !== 'delete' && kind !== 'update') {
			throw new Error(`Unsupported Codex file change kind: ${String(kind)}`);
		}
		const movePath = kind === 'update' && isRecord(change.kind) && typeof change.kind.move_path === 'string' ? change.kind.move_path : undefined;
		changes.push({ path: change.path, kind, movePath });
	}
	const status = item.status;
	return {
		operationId: `${params.threadId}:${params.turnId}:${item.id}`,
		threadId: params.threadId, turnId: params.turnId, itemId: item.id, changes,
		paths: [...new Set(changes.map(change => change.path))],
		status: status === 'inProgress' || status === 'completed' || status === 'failed' || status === 'declined' ? status : 'unknown',
	};
}

function getFileApproval(message: ICodexMessage): { requestId: string | number; operationId: string } | undefined {
	if (message.method !== 'item/fileChange/requestApproval' || (typeof message.id !== 'string' && typeof message.id !== 'number')) {
		return undefined;
	}
	const params = message.params;
	if (!isRecord(params) || typeof params.threadId !== 'string' || typeof params.turnId !== 'string' || typeof params.itemId !== 'string') {
		throw new Error('Codex file approval is missing its operation identity.');
	}
	return { requestId: message.id, operationId: `${params.threadId}:${params.turnId}:${params.itemId}` };
}

/** Resolve in the extension host, where file URIs refer to the agent's machine. */
export function resolveCodexEditResource(path: string, cwd: string | undefined): URI {
	if (isAbsolute(path)) {
		return URI.file(path);
	}
	if (!cwd || !isAbsolute(cwd)) {
		throw new Error(`Cannot resolve relative Codex edit path without its working directory: ${path}`);
	}
	return joinPath(URI.file(cwd), path.replaceAll('\\', '/'));
}

/** Preserve the plugin's approval UI; gate only the user's approval on the snapshot. */
export function installCodexExternalEditBridge(provider: object, lifecycle: ICodexExternalEditLifecycle): IDisposable {
	const appServer = getAppServer(provider);
	const originalHandleIncomingMessage = appServer.handleIncomingMessage;
	const originalSendResponse = appServer.sendResponse;
	const originalSendProviderRequest = appServer.sendProviderRequest;
	const operations = new Map<string, { readonly edit: ICodexExternalEdit; readonly started: Promise<boolean> }>();
	const approvals = new Map<string | number, Promise<boolean>>();
	const workingDirectories = new Map<string, string>();
	const turns = new Map<string, { readonly ready: Promise<void>; readonly requestId: string }>();
	let isDisposed = false;
	const reportError = (error: unknown) => lifecycle.onError(error);
	const finishTurn = (threadId: string) => {
		const turn = turns.get(threadId);
		if (turn) {
			turns.delete(threadId);
			void turn.ready.then(() => lifecycle.endTurn!(threadId)).catch(reportError);
		}
	};
	const finish = (edit: ICodexExternalEdit) => {
		const operation = operations.get(edit.operationId);
		if (!operation) {
			return;
		}
		operations.delete(edit.operationId);
		void operation.started.then(ready => ready ? lifecycle.end({ ...operation.edit, status: edit.status }) : undefined).catch(reportError);
	};

	appServer.handleIncomingMessage = message => {
		const params = isRecord(message.params) ? message.params : undefined;
		const result = isRecord(message.result) ? message.result : undefined;
		const thread = params?.thread ?? result?.thread;
		if (isRecord(thread) && typeof thread.id === 'string' && typeof thread.cwd === 'string') {
			workingDirectories.set(thread.id, thread.cwd);
		}
		const workspaceTurn = typeof params?.threadId === 'string' ? turns.get(params.threadId) : undefined;
		const change = workspaceTurn ? undefined : getFileChange(message);
		const edit = change && { ...change, cwd: workingDirectories.get(change.threadId) };
		if (edit && message.method === 'item/started' && edit.paths.length > 0 && !operations.has(edit.operationId)) {
			const started = Promise.resolve().then(() => lifecycle.begin(edit)).then(() => true, error => {
				reportError(error);
				return false;
			});
			operations.set(edit.operationId, { edit, started });
		} else if (edit && message.method === 'item/completed') {
			finish(edit);
		} else if (message.method === 'turn/completed' && params) {
			if (typeof params.threadId === 'string') { finishTurn(params.threadId); }
			for (const { edit } of operations.values()) {
				if (edit.threadId === params.threadId && isRecord(params.turn) && edit.turnId === params.turn.id) {
					finish({ ...edit, status: 'unknown' });
				}
			}
		}

		const approval = getFileApproval(message);
		if (approval) {
			const operation = operations.get(approval.operationId);
			if (!operation && !workspaceTurn) {
				reportError(new Error(`Codex requested approval for unknown file change ${approval.operationId}.`));
			}
			approvals.set(approval.requestId, workspaceTurn ? workspaceTurn.ready.then(() => true, () => false) : operation?.started ?? Promise.resolve(false));
		}
		if (message.error) {
			for (const [threadId, turn] of turns) {
				if (turn.requestId === message.id) { finishTurn(threadId); }
			}
		}

		return originalHandleIncomingMessage.call(appServer, message);
	};
	appServer.sendResponse = (id, result) => {
		const ready = approvals.get(id);
		approvals.delete(id);
		if (!ready || !isRecord(result) || (result.decision !== 'accept' && result.decision !== 'acceptForSession')) {
			originalSendResponse.call(appServer, id, result);
			return;
		}
		void ready.then(success => {
			if (!isDisposed) {
				originalSendResponse.call(appServer, id, success ? result : { decision: 'decline' });
			}
		}).catch(reportError);
	};

	appServer.sendProviderRequest = (providerName, requestId, method, params, isPrewarm, trackDelivery) => {
		if (isRecord(params) && typeof params.threadId === 'string' && typeof params.cwd === 'string') {
			workingDirectories.set(params.threadId, params.cwd);
		}
		if (method === 'turn/start' && isRecord(params) && typeof params.threadId === 'string' && lifecycle.beginTurn && lifecycle.endTurn) {
			const threadId = params.threadId;
			const responseId = `${providerName}:${requestId}`;
			if (turns.has(threadId)) {
				originalHandleIncomingMessage.call(appServer, { id: responseId, error: { code: -32603, message: 'A Codex workspace review turn is still active.' } });
				return;
			}
			const ready = Promise.resolve().then(() => lifecycle.beginTurn!(threadId));
			turns.set(threadId, { ready, requestId: responseId });
			void ready.then(() => {
				if (!isDisposed) {
					originalSendProviderRequest.call(appServer, providerName, requestId, method, params, isPrewarm, trackDelivery);
				}
			}, error => {
				turns.delete(threadId);
				reportError(error);
				if (!isDisposed) {
					originalHandleIncomingMessage.call(appServer, { id: responseId, error: { code: -32603, message: `Codex workspace review baseline failed: ${String(error)}` } });
				}
			});
			return;
		}
		return originalSendProviderRequest.call(
			appServer,
			providerName,
			requestId,
			method,
			params,
			isPrewarm,
			trackDelivery,
		);
	};

	return toDisposable(() => {
		isDisposed = true;
		for (const threadId of turns.keys()) { finishTurn(threadId); }
		for (const { edit } of operations.values()) {
			finish({ ...edit, status: 'unknown' });
		}
		approvals.clear();
		workingDirectories.clear();
		appServer.handleIncomingMessage = originalHandleIncomingMessage;
		appServer.sendResponse = originalSendResponse;
		appServer.sendProviderRequest = originalSendProviderRequest;
	});
}
