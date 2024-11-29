import * as vscode from 'vscode';

interface DartElement {
	kind: string;
	name: string;
	parameters?: string;
	typeParameters?: string;
	returnType?: string;
	range: {
		start: { line: number; character: number; };
		end: { line: number; character: number; };
	};
}

interface OutlineNode {
	children?: OutlineNode[];
	element: DartElement;
	range: {
		start: { line: number; character: number; };
		end: { line: number; character: number; };
	};
}

// Add this as a module-level variable
let currentArrayContext: { parentName: string, elements: any[] } | null = null;

export async function activate(context: vscode.ExtensionContext) {
	console.log('Attempting to activate Flutter Code Jumper...');

	const dartExt = vscode.extensions.getExtension('Dart-Code.dart-code');
	if (!dartExt) {
		vscode.window.showErrorMessage('Dart extension is not installed');
		return;
	}

	try {
		if (!dartExt.isActive) {
			await dartExt.activate();
		}

		const privateApi = dartExt.exports._privateApi;

		// Register all commands
		registerNavigationCommands(context, privateApi);

		console.log('Flutter Code Jumper activated successfully');

	} catch (e) {
		console.error('Activation error:', e);
		vscode.window.showErrorMessage('Failed to initialize Flutter Code Jumper');
	}
}

function registerNavigationCommands(context: vscode.ExtensionContext, privateApi: any) {
	// Parent navigation command
	context.subscriptions.push(
		vscode.commands.registerTextEditorCommand(
			'flutter-code-jumper.navigateToParent',
			async (editor) => {
				if (editor.document.languageId !== 'dart') return;

				const document = editor.document;
				const position = editor.selection.active;
				const outline = await privateApi.fileTracker.getOutlineFor(document.uri);

				if (!outline) return;

				// Find the current node we're in
				const currentNode = findNodeAtPosition(outline, position.line, position.character);
				if (!currentNode) return;

				// If we're not at the start of current node, move there first
				const nodeStart = new vscode.Position(
					currentNode.range.start.line,
					currentNode.range.start.character
				);

				if (!position.isEqual(nodeStart)) {
					editor.selection = new vscode.Selection(nodeStart, nodeStart);
					editor.revealRange(new vscode.Range(nodeStart, nodeStart));
					return;
				}

				// If we're already at the start of current node, find its parent
				const parentNode = findParentNodeExcludingCurrent(outline, currentNode);
				if (parentNode) {
					const parentStart = new vscode.Position(
						parentNode.range.start.line,
						parentNode.range.start.character
					);
					editor.selection = new vscode.Selection(parentStart, parentStart);
					editor.revealRange(new vscode.Range(parentStart, parentStart));
				}
			}
		)
	);

	// Child navigation command - updated version
	context.subscriptions.push(
		vscode.commands.registerTextEditorCommand(
			'flutter-code-jumper.navigateToChild',
			async (editor) => {
				if (editor.document.languageId !== 'dart') return;

				const document = editor.document;
				const position = editor.selection.active;
				const outline = await privateApi.fileTracker.getOutlineFor(document.uri);

				if (!outline) return;

				const currentNode = findNodeAtPosition(outline, position.line, position.character);
				if (!currentNode) return;

				// Find child node (prefer 'child' or first element of 'children')
				const childNode = findFirstChildNode(currentNode);
				if (childNode) {
					const childStart = new vscode.Position(
						childNode.range.start.line,
						childNode.range.start.character
					);
					editor.selection = new vscode.Selection(childStart, childStart);
					editor.revealRange(new vscode.Range(childStart, childStart));
				} else {
					// If no child nodes, move inside the current widget
					const text = document.getText(new vscode.Range(
						currentNode.range.start.line,
						currentNode.range.start.character,
						currentNode.range.end.line,
						currentNode.range.end.character
					));

					// Find the position after the first '('
					const match = text.match(/\(/);
					if (match) {
						const offset = match.index! + 1;
						const pos = document.positionAt(
							document.offsetAt(new vscode.Position(currentNode.range.start.line, currentNode.range.start.character)) + offset
						);
						editor.selection = new vscode.Selection(pos, pos);
						editor.revealRange(new vscode.Range(pos, pos));
					}
				}
			}
		)
	);

	// Parameter navigation commands
	context.subscriptions.push(
		vscode.commands.registerTextEditorCommand(
			'flutter-code-jumper.navigateNextParam',
			async (editor) => {
				if (editor.document.languageId !== 'dart') return;
				await navigateParams(editor, privateApi, true);
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerTextEditorCommand(
			'flutter-code-jumper.navigatePrevParam',
			async (editor) => {
				if (editor.document.languageId !== 'dart') return;
				await navigateParams(editor, privateApi, false);
			}
		)
	);

	// Select current block command
	context.subscriptions.push(
		vscode.commands.registerTextEditorCommand(
			'flutter-code-jumper.selectCurrentBlock',
			async (editor) => {
				if (editor.document.languageId !== 'dart') return;

				const document = editor.document;
				const position = editor.selection.active;
				const outline = await privateApi.fileTracker.getOutlineFor(document.uri);

				if (!outline) return;

				// If there's already a selection, find its exact parent
				if (!editor.selection.isEmpty) {
					const selectionStart = editor.selection.start;
					const selectionEnd = editor.selection.end;

					const currentNode = findExactNode(outline, selectionStart, selectionEnd);
					if (!currentNode) return;

					const parentNode = findParentNodeExcludingCurrent(outline, currentNode);
					if (parentNode) {
						const range = new vscode.Range(
							new vscode.Position(parentNode.range.start.line, parentNode.range.start.character),
							new vscode.Position(parentNode.range.end.line, parentNode.range.end.character)
						);
						editor.selection = new vscode.Selection(range.start, range.end);
						editor.revealRange(range);
					}
					return;
				}

				// Find the smallest node at current position
				const currentNode = findSmallestNode(outline, position.line, position.character);
				if (!currentNode) return;

				const range = new vscode.Range(
					new vscode.Position(currentNode.range.start.line, currentNode.range.start.character),
					new vscode.Position(currentNode.range.end.line, currentNode.range.end.character)
				);

				editor.selection = new vscode.Selection(range.start, range.end);
				editor.revealRange(range);
			}
		)
	);

	// Enter widget command
	context.subscriptions.push(
		vscode.commands.registerTextEditorCommand(
			'flutter-code-jumper.enterWidget',
			async (editor) => {
				if (editor.document.languageId !== 'dart') return;

				const document = editor.document;
				const position = editor.selection.active;
				const outline = await privateApi.fileTracker.getOutlineFor(document.uri);

				if (!outline) return;

				const currentNode = findNodeAtPosition(outline, position.line, position.character);
				if (!currentNode) return;

				const text = document.getText(new vscode.Range(
					currentNode.range.start.line,
					currentNode.range.start.character,
					currentNode.range.end.line,
					currentNode.range.end.character
				));

				const openParenIndex = text.indexOf('(');
				if (openParenIndex !== -1) {
					const pos = document.positionAt(
						document.offsetAt(new vscode.Position(currentNode.range.start.line, currentNode.range.start.character)) + openParenIndex + 1
					);
					editor.selection = new vscode.Selection(pos, pos);
					editor.revealRange(new vscode.Range(pos, pos));
				}
			}
		)
	);
}

async function navigateParams(editor: vscode.TextEditor, privateApi: any, forward: boolean) {
	const document = editor.document;
	const position = editor.selection.active;
	console.log('\n=== Navigation Debug ===');
	console.log(`Direction: ${forward ? 'forward' : 'backward'}`);
	console.log(`Cursor position: line ${position.line}, char ${position.character}`);

	const outline = await privateApi.fileTracker.getOutlineFor(document.uri);
	if (!outline) {
		console.log('No outline found');
		return;
	}

	const currentNode = findNodeAtPosition(outline, position.line, position.character);
	if (!currentNode) {
		console.log('No current node found');
		return;
	}
	console.log('Current node:', {
		kind: currentNode.element.kind,
		name: currentNode.element.name,
		range: currentNode.range,
		childrenCount: currentNode.children?.length || 0,
		children: currentNode.children?.map(child => ({
			kind: child.element.kind,
			name: child.element.name
		}))
	});

	let navigableElements: { start: vscode.Position; end: vscode.Position }[] = [];
	let parentNode = currentNode;

	// Find the innermost constructor containing the cursor
	let targetNode = currentNode;
	const allNodes = findAllNodesWithinRange(outline, {
		start: { line: 0, character: 0 },
		end: {
			line: document.lineCount - 1,
			character: document.lineAt(document.lineCount - 1).text.length
		}
	});

	const constructors = allNodes
		?.filter(node =>
			node.element.kind === 'CONSTRUCTOR_INVOCATION' &&
			isPositionWithinRange(position.line, position.character, node.range)
		)
		.sort((a, b) => {
			// Calculate range size for each constructor
			const aSize = (a.range.end.line - a.range.start.line) * 1000 +
				(a.range.end.character - a.range.start.character);
			const bSize = (b.range.end.line - b.range.start.line) * 1000 +
				(b.range.end.character - b.range.start.character);
			// Return smaller range first
			return aSize - bSize;
		});

	if (constructors.length > 0) {
		// Use the smallest (innermost) constructor
		targetNode = constructors[0];
		console.log('Found innermost constructor:', {
			name: targetNode.element.name,
			range: {
				start: `${targetNode.range.start.line}:${targetNode.range.start.character}`,
				end: `${targetNode.range.end.line}:${targetNode.range.end.character}`
			}
		});
	}

	// Check if we're inside any array
	const isInArray = allNodes.some(node => {
		// Check for array-like structures (only if cursor is directly inside the array)
		const isArrayLike = node.children && node.children.length > 0 &&
			node.children.every(child =>
				child.element.kind === 'CONSTRUCTOR_INVOCATION' ||
				child.element.kind === 'METHOD_INVOCATION' ||
				child.element.kind === 'IDENTIFIER'
			) &&
			isPositionWithinRange(position.line, position.character, node.range) &&
			// Check if this is the immediate parent (no other arrays in between)
			!allNodes.some(otherNode =>
				otherNode !== node &&
				isPositionWithinRange(position.line, position.character, otherNode.range) &&
				isPositionWithinRange(otherNode.range.start.line, otherNode.range.start.character, node.range) &&
				otherNode.children && otherNode.children.length > 0
			);

		if (isArrayLike) {
			parentNode = node;
			return true;
		}
		return false;
	});

	console.log('Is in array:', isInArray);

	if (targetNode.element.kind === 'CONSTRUCTOR_INVOCATION' && targetNode.element.parameters) {
		console.log('Processing constructor parameters');

		// Get parameters from DartElement.parameters
		const paramsText = targetNode.element.parameters;
		const params = extractParameters(paramsText, document, new vscode.Position(targetNode.range.start.line, targetNode.range.start.character));

		navigableElements = params.map(param => ({
			start: new vscode.Position(param.start.line, param.start.character),
			end: new vscode.Position(param.end.line, param.end.character)
		}));

		console.log('Constructor parameters:', navigableElements);

		if (!navigableElements?.length) {
			console.log('No navigable parameters found');
			return;
		}

		const currentIndex = navigableElements.findIndex(elem =>
			isPositionWithinRange(position.line, position.character, {
				start: elem.start,
				end: elem.end
			})
		);

		console.log('Current index:', currentIndex);

		const nextIndex = forward ?
			(currentIndex + 1) % navigableElements.length :
			(currentIndex === -1 ? navigableElements.length - 1 :
				(currentIndex - 1 + navigableElements.length) % navigableElements.length);

		console.log('Next index:', nextIndex);

		const nextElement = navigableElements[nextIndex];
		console.log('Next element:', nextElement);

		// Set the selection from start to end of the next parameter
		editor.selections = [new vscode.Selection(nextElement.start, nextElement.end)];
		editor.revealRange(new vscode.Range(nextElement.start, nextElement.end));

		return;
	}

	if (isInArray) {
		console.log('Processing array navigation');

		// Get array elements from parent node's children
		navigableElements = parentNode.children?.map((child, index) => ({
			index,
			start: new vscode.Position(child.range.start.line, child.range.start.character),
			end: new vscode.Position(child.range.end.line, child.range.end.character)
		})) || [];

		console.log('Array elements:', navigableElements);

		if (!navigableElements?.length) {
			console.log('No navigable elements found');
			return;
		}

		const currentIndex = navigableElements.findIndex(elem =>
			isPositionWithinRange(position.line, position.character, {
				start: elem.start,
				end: elem.end
			})
		);

		console.log('Current index:', currentIndex);

		const nextIndex = forward ?
			(currentIndex + 1) % navigableElements.length :
			(currentIndex === -1 ? navigableElements.length - 1 :
				(currentIndex - 1 + navigableElements.length) % navigableElements.length);

		console.log('Next index:', nextIndex);

		const nextElement = navigableElements[nextIndex];
		console.log('Next element:', nextElement);

		// Set the selection from start to end of the next element
		editor.selections = [new vscode.Selection(nextElement.start, nextElement.end)];
		editor.revealRange(new vscode.Range(nextElement.start, nextElement.end));

		return;
	}
}

function extractParameters(paramsText: string, document: vscode.TextDocument, startPosition: vscode.Position): { start: vscode.Position, end: vscode.Position }[] {
	const params: { start: vscode.Position, end: vscode.Position }[] = [];
	const regex = /(\w+)\s*:\s*([^,]+)(,|$)/g;
	let match;
	while ((match = regex.exec(paramsText)) !== null) {
		const paramName = match[1];
		const paramValue = match[2];
		const startOffset = document.offsetAt(startPosition) + match.index;
		const endOffset = startOffset + match[0].length;
		const start = document.positionAt(startOffset);
		const end = document.positionAt(endOffset);
		params.push({ start, end });
	}
	return params;
}

function findNextCommaPosition(document: vscode.TextDocument, pos: vscode.Position): vscode.Position | null {
	const line = document.lineAt(pos.line);
	const textAfter = line.text.substring(pos.character);
	const commaMatch = textAfter.match(/\s*,/);

	if (commaMatch) {
		return new vscode.Position(pos.line, pos.character + commaMatch[0].length);
	}
	return null;
}

function findLastIndex<T>(array: T[], predicate: (value: T) => boolean): number {
	for (let i = array.length - 1; i >= 0; i--) {
		if (predicate(array[i])) return i;
	}
	return -1;
}

function determineNavigationContext(node: OutlineNode, root: OutlineNode, position: vscode.Position): string {
	console.log('=== Context Detection ===');
	console.log(`Initial node: ${node.element.kind} - ${node.element.name}`);

	// Проверяем, есть ли у текущего узла параметр children
	const childrenParam = node.children?.find(
		child => child.element.kind === 'NAMED_ARGUMENT' && child.element.name === 'children'
	);

	console.log('Children param found:', childrenParam ? 'yes' : 'no');

	if (childrenParam) {
		console.log('Children param range:',
			`${childrenParam.range.start.line}:${childrenParam.range.start.character}`,
			`${childrenParam.range.end.line}:${childrenParam.range.end.character}`);
		console.log('Current position:', `${position.line}:${position.character}`);

		if (isPositionWithinRange(position.line, position.character, childrenParam.range)) {
			console.log('Position is within children array');
			return 'array';
		}
	}

	return 'widget';
}

function findNearestConstructor(node: OutlineNode, root: OutlineNode): OutlineNode | null {
	let current = node;
	while (current) {
		if (current.element.kind === 'CONSTRUCTOR_INVOCATION') {
			return current;
		}
		const parent = findParentNodeExcludingCurrent(root, current);
		if (!parent || parent.element.kind === 'NAMED_ARGUMENT' && parent.element.name === 'children') {
			break;
		}
		current = parent;
	}
	return null;
}

function findParentArray(node: OutlineNode, root: OutlineNode): OutlineNode | null {
	let current = node;
	while (current) {
		const parent = findParentNodeExcludingCurrent(root, current);
		if (!parent) break;

		// Проверяем, является ли родитель массивом
		if (parent.element.kind === 'LIST_LITERAL' ||
			(parent.element.kind === 'NAMED_ARGUMENT' &&
				parent.element.name === 'children')) {
			return parent;
		}

		current = parent;
	}
	return null;
}

function findParentNodeExcludingCurrent(root: OutlineNode, currentNode: OutlineNode): OutlineNode | null {
	if (!root.children) return null;

	// Check if current node is direct child of root
	const isDirectChild = root.children.some(child =>
		child.range.start.line === currentNode.range.start.line &&
		child.range.start.character === currentNode.range.start.character
	);

	if (isDirectChild) return root;

	// Recursively search in children
	for (const child of root.children) {
		const found = findParentNodeExcludingCurrent(child, currentNode);
		if (found) return found;
	}

	return null;
}

function findNodeAtPosition(node: OutlineNode, line: number, character: number): OutlineNode | null {
	if (!isPositionWithinRange(line, character, node.range)) {
		return null;
	}

	if (node.children) {
		for (const child of node.children) {
			const foundNode = findNodeAtPosition(child, line, character);
			if (foundNode) return foundNode;
		}
	}

	return node;
}

function findFirstChildNode(node: OutlineNode): OutlineNode | null {
	if (!node.children?.length) return null;

	// Try to find 'child' parameter first
	const childParam = node.children.find(child =>
		child.element.name === 'child' ||
		child.element.name === 'children'
	);

	return childParam || node.children[0];
}

function isPositionWithinRange(
	line: number,
	character: number,
	range: { start: { line: number; character: number; }; end: { line: number; character: number; }; }
): boolean {
	return (line > range.start.line || (line === range.start.line && character >= range.start.character)) &&
		(line < range.end.line || (line === range.end.line && character <= range.end.character));
}

// New helper functions for selectCurrentBlock
function findExactNode(node: OutlineNode, start: vscode.Position, end: vscode.Position): OutlineNode | null {
	if (node.range.start.line === start.line &&
		node.range.start.character === start.character &&
		node.range.end.line === end.line &&
		node.range.end.character === end.character) {
		return node;
	}

	if (node.children) {
		for (const child of node.children) {
			const found = findExactNode(child, start, end);
			if (found) return found;
		}
	}

	return null;
}

function findSmallestNode(node: OutlineNode, line: number, character: number): OutlineNode | null {
	if (!isPositionWithinRange(line, character, node.range)) {
		return null;
	}

	if (node.children) {
		for (const child of node.children) {
			const foundNode = findSmallestNode(child, line, character);
			if (foundNode) return foundNode;
		}
	}

	return node;
}

function findParentOfType(node: OutlineNode, root: OutlineNode, name: string | null, kind: string): OutlineNode | null {
	let current = node;
	while (current) {
		const parent = findParentNodeExcludingCurrent(root, current);
		if (!parent) break;

		if (parent.element.kind === kind && (name === null || parent.element.name === name)) {
			return parent;
		}
		current = parent;
	}
	return null;
}

// Add this new helper function
function findAllNodesOfType(node: OutlineNode, kind: string): OutlineNode[] {
	let results: OutlineNode[] = [];

	if (node.element.kind === kind) {
		results.push(node);
	}

	if (node.children) {
		for (const child of node.children) {
			results = results.concat(findAllNodesOfType(child, kind));
		}
	}

	return results;
}

// Add this new helper function
function findAllNodesWithinRange(
	node: OutlineNode,
	range: { start: { line: number; character: number }; end: { line: number; character: number } }
): OutlineNode[] {
	let results: OutlineNode[] = [];

	// Check if this node is within the range
	const nodeStart = node.range.start;
	const nodeEnd = node.range.end;
	const rangeStart = range.start;
	const rangeEnd = range.end;

	const isWithinRange =
		(nodeStart.line >= rangeStart.line &&
			nodeEnd.line <= rangeEnd.line) &&
		(nodeStart.line > rangeStart.line ||
			nodeStart.character >= rangeStart.character) &&
		(nodeEnd.line < rangeEnd.line ||
			nodeEnd.character <= rangeEnd.character);

	if (isWithinRange) {
		results.push(node);
	}

	// Check children
	if (node.children) {
		for (const child of node.children) {
			results = results.concat(findAllNodesWithinRange(child, range));
		}
	}

	return results;
}

export function deactivate() {
	// No need to dispose anything as Dart extension handles it
}
