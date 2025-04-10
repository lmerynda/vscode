/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SymbolItemDragAndDrop, SymbolItemEditorHighlights, SymbolItemNavigation, SymbolTreeInput } from '../references-view';
import { asResourceUrl, del, getThemeIcon, tail } from '../utils';

export class CallsTreeInput implements SymbolTreeInput<CallItem> {

	readonly title: string;
	readonly contextValue: string = 'callHierarchy';

	constructor(
		readonly location: vscode.Location,
		readonly direction: CallsDirection,
	) {
		this.title = direction === CallsDirection.Incoming
			? vscode.l10n.t('Callers Of')
			: vscode.l10n.t('Calls From');
	}

	async resolve() {

		const items = await Promise.resolve(vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', this.location.uri, this.location.range.start));
		const model = new CallsModel(this.direction, items ?? []);
		const provider = new CallItemDataProvider(model);

		if (model.roots.length === 0) {
			return;
		}

		return {
			provider,
			get message() { return model.roots.length === 0 ? vscode.l10n.t('No results.') : undefined; },
			navigation: model,
			highlights: model,
			dnd: model,
			dispose() {
				provider.dispose();
			}
		};
	}

	with(location: vscode.Location): CallsTreeInput {
		return new CallsTreeInput(location, this.direction);
	}
}


export const enum CallsDirection {
	Incoming,
	Outgoing
}



export class CallItem {

	children?: CallItem[];

	constructor(
		readonly model: CallsModel,
		readonly item: vscode.CallHierarchyItem,
		readonly parent: CallItem | undefined,
		readonly locations: vscode.Location[] | undefined
	) { }

	remove(): void {
		this.model.remove(this);
	}
}

class CallsModel implements SymbolItemNavigation<CallItem>, SymbolItemEditorHighlights<CallItem>, SymbolItemDragAndDrop<CallItem> {

	readonly roots: CallItem[] = [];

	private readonly _onDidChange = new vscode.EventEmitter<CallsModel>();
	readonly onDidChange = this._onDidChange.event;

	constructor(readonly direction: CallsDirection, items: vscode.CallHierarchyItem[]) {
		this.roots = items.map(item => new CallItem(this, item, undefined, undefined));
	}

	private getGroupedIncomingCalls(call: CallItem, incomingCalls: vscode.CallHierarchyIncomingCall[]): CallItem[] {
		return incomingCalls.map(item => new CallItem(this, item.from, call, item.fromRanges.map(range => new vscode.Location(item.from.uri, range))));
	}

	private getGroupedOutgoingCalls(call: CallItem, outgoingCalls: vscode.CallHierarchyOutgoingCall[]): CallItem[] {
		return outgoingCalls.map(item => new CallItem(this, item.to, call, item.fromRanges.map(range => new vscode.Location(item.to.uri, range))));
	}

	private getFlatIncomingCalls(call: CallItem, incomingCalls: vscode.CallHierarchyIncomingCall[]): CallItem[] {
		return incomingCalls.flatMap(item =>
			item.fromRanges.map(range =>
				new CallItem(this, item.from, call, [new vscode.Location(item.from.uri, range)])
			)
		);
	}

	private getFlatOutgoingCalls(call: CallItem, outgoingCalls: vscode.CallHierarchyOutgoingCall[]): CallItem[] {
		return outgoingCalls.flatMap(item =>
			item.fromRanges.map(range =>
				new CallItem(this, item.to, call, [new vscode.Location(item.to.uri, range)])
			)
		);
	}

	private async _resolveCalls(call: CallItem): Promise<CallItem[]> {
		const groupCalls = vscode.workspace.getConfiguration('references').get<boolean>('groupCalls', true);
		if (this.direction === CallsDirection.Incoming) {
			const calls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', call.item);
			return calls ? (groupCalls ? this.getGroupedIncomingCalls(call, calls) : this.getFlatIncomingCalls(call, calls)) : [];
		} else {
			const calls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', call.item);
			return calls ? (groupCalls ? this.getGroupedOutgoingCalls(call, calls) : this.getFlatOutgoingCalls(call, calls)) : [];
		}
	}

	async getCallChildren(call: CallItem): Promise<CallItem[]> {
		if (!call.children) {
			call.children = await this._resolveCalls(call);
		}
		return call.children;
	}

	// -- navigation

	location(item: CallItem) {
		return new vscode.Location(item.item.uri, item.item.range);
	}

	nearest(uri: vscode.Uri, _position: vscode.Position): CallItem | undefined {
		return this.roots.find(item => item.item.uri.toString() === uri.toString()) ?? this.roots[0];
	}

	next(from: CallItem): CallItem {
		return this._move(from, true) ?? from;
	}

	previous(from: CallItem): CallItem {
		return this._move(from, false) ?? from;
	}

	private _move(item: CallItem, fwd: boolean): CallItem | void {
		if (item.children?.length) {
			return fwd ? item.children[0] : tail(item.children);
		}
		const array = this.roots.includes(item) ? this.roots : item.parent?.children;
		if (array?.length) {
			const idx = array.indexOf(item);
			const delta = fwd ? 1 : -1;
			return array[idx + delta + array.length % array.length];
		}
	}

	// --- dnd

	getDragUri(item: CallItem): vscode.Uri | undefined {
		return asResourceUrl(item.item.uri, item.item.range);
	}

	// --- highlights

	getEditorHighlights(item: CallItem, uri: vscode.Uri): vscode.Range[] | undefined {
		if (!item.locations) {
			return item.item.uri.toString() === uri.toString() ? [item.item.selectionRange] : undefined;
		}
		return item.locations
			.filter(loc => loc.uri.toString() === uri.toString())
			.map(loc => loc.range);
	}

	remove(item: CallItem) {
		const isInRoot = this.roots.includes(item);
		const siblings = isInRoot ? this.roots : item.parent?.children;
		if (siblings) {
			del(siblings, item);
			this._onDidChange.fire(this);
		}
	}
}

class CallItemDataProvider implements vscode.TreeDataProvider<CallItem> {

	private readonly _emitter = new vscode.EventEmitter<CallItem | undefined>();
	readonly onDidChangeTreeData = this._emitter.event;

	private readonly _modelListener: vscode.Disposable;

	constructor(private _model: CallsModel) {
		this._modelListener = _model.onDidChange(e => this._emitter.fire(e instanceof CallItem ? e : undefined));
	}

	dispose(): void {
		this._emitter.dispose();
		this._modelListener.dispose();
	}

	getLocationString(element: CallItem): string | undefined {
		const fileComponent = element.item.uri.path.split('/').at(-1) ?? '';
		const locations = element.locations?.map(loc => loc.range.start.line + 1).join(', ');
		const result = `${fileComponent}${locations ? `:${locations}` : ''}`;

		return result ? result : undefined;
	}

	getTreeItem(element: CallItem): vscode.TreeItem {

		const item = new vscode.TreeItem(element.item.name);
		const locationString = this.getLocationString(element);
		item.description = locationString ? `${element.item.detail} ${locationString}` : element.item.detail;
		item.tooltip = item.label && element.item.detail ? `${item.label} - ${element.item.detail}` : item.label ? `${item.label}` : element.item.detail;
		item.contextValue = 'call-item';
		item.iconPath = getThemeIcon(element.item.kind);

		type OpenArgs = [vscode.Uri, vscode.TextDocumentShowOptions];
		let openArgs: OpenArgs;

		if (element.model.direction === CallsDirection.Outgoing) {

			openArgs = [element.item.uri, { selection: element.item.selectionRange.with({ end: element.item.selectionRange.start }) }];

		} else {
			// incoming call -> reveal first call instead of caller
			let firstLoctionStart: vscode.Position | undefined;
			if (element.locations) {
				for (const loc of element.locations) {
					if (loc.uri.toString() === element.item.uri.toString()) {
						firstLoctionStart = firstLoctionStart?.isBefore(loc.range.start) ? firstLoctionStart : loc.range.start;
					}
				}
			}
			if (!firstLoctionStart) {
				firstLoctionStart = element.item.selectionRange.start;
			}
			openArgs = [element.item.uri, { selection: new vscode.Range(firstLoctionStart, firstLoctionStart) }];
		}

		item.command = {
			command: 'vscode.open',
			title: vscode.l10n.t('Open Call'),
			arguments: openArgs
		};
		item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
		return item;
	}

	getChildren(element?: CallItem | undefined) {
		return element
			? this._model.getCallChildren(element)
			: this._model.roots;
	}

	getParent(element: CallItem) {
		return element.parent;
	}
}
