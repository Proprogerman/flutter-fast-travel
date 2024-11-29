import * as vscode from 'vscode';

interface DartElement {
	kind: string;
	name: string;
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
		.filter(node =>
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

	// Check if we're inside a children array
	const isInChildrenArray = allNodes.some(node => {
		if (node.element.kind === 'NAMED_ARGUMENT' && node.element.name === 'children') {
			// Find the LIST_LITERAL inside children argument
			const listLiteral = node.children?.find(child => child.element.kind === 'LIST_LITERAL');
			if (listLiteral) {
				// Get the actual array content range (between [ and ])
				const arrayText = editor.document.getText(new vscode.Range(
					listLiteral.range.start.line,
					listLiteral.range.start.character,
					listLiteral.range.end.line,
					listLiteral.range.end.character
				));

				// Find the opening bracket position
				const openBracketIndex = arrayText.indexOf('[');
				if (openBracketIndex !== -1) {
					const arrayStartPos = editor.document.positionAt(
						editor.document.offsetAt(new vscode.Position(listLiteral.range.start.line, listLiteral.range.start.character)) +
						openBracketIndex + 1
					);

					// Create range for array content (between brackets)
					const arrayContentRange = {
						start: arrayStartPos,
						end: new vscode.Position(listLiteral.range.end.line, listLiteral.range.end.character - 1) // -1 to exclude closing bracket
					};

					console.log('Array content range:', {
						start: `${arrayContentRange.start.line}:${arrayContentRange.start.character}`,
						end: `${arrayContentRange.end.line}:${arrayContentRange.end.character}`,
						position: `${position.line}:${position.character}`
					});

					// Check if cursor is within array content
					const isWithinArray =
						(position.line > arrayContentRange.start.line ||
							(position.line === arrayContentRange.start.line && position.character >= arrayContentRange.start.character)) &&
						(position.line < arrayContentRange.end.line ||
							(position.line === arrayContentRange.end.line && position.character <= arrayContentRange.end.character));

					if (isWithinArray) {
						// Also check if we're not inside a parameter of a child widget
						const isInChildParameter = allNodes.some(n =>
							n.element.kind === 'NAMED_ARGUMENT' &&
							n.element.name !== 'children' &&
							isPositionWithinRange(position.line, position.character, n.range)
						);

						console.log('Within array:', isWithinArray);
						console.log('In child parameter:', isInChildParameter);
						return isWithinArray && !isInChildParameter;
					}
				}
			}
		}
		return false;
	});

	console.log('Is in children array:', isInChildrenArray);

	if (isInChildrenArray) {
		// Find the children array node
		const childrenNode = allNodes.find(node => {
			if (node.element.kind === 'NAMED_ARGUMENT' && node.element.name === 'children') {
				const listLiteral = node.children?.find(child => child.element.kind === 'LIST_LITERAL');
				if (listLiteral) {
					return isPositionWithinRange(position.line, position.character, listLiteral.range);
				}
			}
			return false;
		});

		if (childrenNode && childrenNode.children) {
			const listLiteral = childrenNode.children.find(child => child.element.kind === 'LIST_LITERAL');
			if (listLiteral && listLiteral.children) {
				console.log('Array elements:', listLiteral.children.map(elem => ({
					kind: elem.element.kind,
					name: elem.element.name,
					range: {
						start: `${elem.range.start.line}:${elem.range.start.character}`,
						end: `${elem.range.end.line}:${elem.range.end.character}`
					}
				})));

				// Use the full range of each constructor for navigation
				navigableElements = listLiteral.children.map(elem => {
					// Find the full constructor range if this is a constructor invocation
					const constructorNode = allNodes.find(node =>
						node.element.kind === 'CONSTRUCTOR_INVOCATION' &&
						node.range.start.line === elem.range.start.line &&
						node.range.start.character === elem.range.start.character
					);

					return {
						start: new vscode.Position(elem.range.start.line, elem.range.start.character),
						end: new vscode.Position(
							constructorNode?.range.end.line || elem.range.end.line,
							constructorNode?.range.end.character || elem.range.end.character
						)
					};
				});

				// Skip to navigation logic
				if (navigableElements.length > 0) {
					let nextIndex = -1;

					if (editor.selection.isEmpty) {
						const currentElemIndex = navigableElements.findIndex((elem, index) => {
							const nextElem = index < navigableElements.length - 1 ? navigableElements[index + 1] : null;
							const rangeEnd = nextElem ? nextElem.start : elem.end;

							const isInRange = position.line >= elem.start.line && position.line <= rangeEnd.line &&
								(position.line !== elem.start.line || position.character >= elem.start.character) &&
								(position.line !== rangeEnd.line || position.character <= rangeEnd.character);

							if (isInRange) {
								console.log(`Cursor is within element ${index}`);
							}
							return isInRange;
						});

						console.log('Current element index:', currentElemIndex);

						if (forward) {
							if (currentElemIndex !== -1) {
								nextIndex = (currentElemIndex + 1) % navigableElements.length;
								console.log('Moving to next element:', nextIndex);
							} else {
								nextIndex = navigableElements.findIndex(elem => position.isBefore(elem.start));
								if (nextIndex === -1) nextIndex = 0;
								console.log('Moving to nearest next element:', nextIndex);
							}
						} else {
							if (currentElemIndex !== -1) {
								nextIndex = currentElemIndex;
								console.log('Selecting current element:', nextIndex);
							} else {
								nextIndex = findLastIndex(navigableElements, elem => position.isAfter(elem.end));
								if (nextIndex === -1) nextIndex = navigableElements.length - 1;
								console.log('Moving to nearest previous element:', nextIndex);
							}
						}
					} else {
						// Selection handling with logging
						const currentIndex = navigableElements.findIndex(elem =>
							elem.start.isEqual(editor.selection.start) && elem.end.isEqual(editor.selection.end));
						console.log('Current selection index:', currentIndex);

						if (currentIndex !== -1) {
							if (forward) {
								nextIndex = (currentIndex + 1) % navigableElements.length;
								console.log('Moving selection to next:', nextIndex);
							} else {
								nextIndex = (currentIndex - 1 + navigableElements.length) % navigableElements.length;
								console.log('Moving selection to previous:', nextIndex);
							}
						}
					}

					if (nextIndex !== -1) {
						const nextElement = navigableElements[nextIndex];
						console.log('Final navigation target:', {
							index: nextIndex,
							start: `${nextElement.start.line}:${nextElement.start.character}`,
							end: `${nextElement.end.line}:${nextElement.end.character}`
						});

						editor.selection = new vscode.Selection(nextElement.start, nextElement.start);
						editor.selection = new vscode.Selection(nextElement.start, nextElement.end);
						editor.revealRange(new vscode.Range(nextElement.start, nextElement.end));
					}
					return; // Exit early after navigation
				}
			}
		}
	}

	// If not in children array, continue with parameter navigation
	if (targetNode.element.kind === 'CONSTRUCTOR_INVOCATION') {
		console.log('Constructor range:', {
			start: `${targetNode.range.start.line}:${targetNode.range.start.character}`,
			end: `${targetNode.range.end.line}:${targetNode.range.end.character}`
		});

		// Get the constructor text
		const text = editor.document.getText(new vscode.Range(
			targetNode.range.start.line,
			targetNode.range.start.character,
			targetNode.range.end.line,
			targetNode.range.end.character
		));

		// Find opening parenthesis
		const openParenIndex = text.indexOf('(');
		if (openParenIndex !== -1) {
			const startPos = editor.document.positionAt(
				editor.document.offsetAt(new vscode.Position(targetNode.range.start.line, targetNode.range.start.character)) +
				openParenIndex + 1
			);

			let params: { name: string | null; start: vscode.Position; end: vscode.Position }[] = [];
			let searchStartOffset = editor.document.offsetAt(startPos);
			let constructorArgs = text.substring(openParenIndex + 1);

			// Parse the constructor arguments
			let depth = 0;
			let currentParam = '';
			let currentParamStart = 0;
			let nameStart = -1;
			let valueStart = -1;
			let paramName: string | null = null;
			let inString = false;
			let stringChar = '';

			for (let i = 0; i < constructorArgs.length; i++) {
				const char = constructorArgs[i];

				// Handle string literals
				if ((char === '"' || char === "'") && (i === 0 || constructorArgs[i - 1] !== '\\')) {
					if (!inString) {
						inString = true;
						stringChar = char;
					} else if (char === stringChar) {
						inString = false;
					}
				}

				// Only count brackets when not in a string
				if (!inString) {
					if (char === '(' || char === '{' || char === '[') {
						depth++;
					} else if (char === ')' || char === '}' || char === ']') {
						depth--;
						if (depth < 0) break; // End of constructor
					} else if (depth === 0 && char === ':' && valueStart === -1) {
						paramName = constructorArgs.substring(nameStart, i).trim();
						valueStart = i + 1;
					} else if (depth === 0 && char === ',' && !inString) {
						// Parameter complete
						if (valueStart === -1) {
							// Positioned parameter
							valueStart = currentParamStart;
							paramName = null;
						}

						// Find the actual end of the value by trimming trailing whitespace
						let valueEnd = i;
						while (valueEnd > valueStart && /\s/.test(constructorArgs[valueEnd - 1])) {
							valueEnd--;
						}

						// Find the actual start of the value by trimming leading whitespace
						while (valueStart < valueEnd && /\s/.test(constructorArgs[valueStart])) {
							valueStart++;
						}

						const paramStartPos = editor.document.positionAt(searchStartOffset + valueStart);
						const paramEndPos = editor.document.positionAt(searchStartOffset + valueEnd);

						params.push({
							name: paramName,
							start: paramStartPos,
							end: paramEndPos
						});

						// Reset for next parameter
						currentParamStart = i + 1;
						nameStart = i + 1;
						valueStart = -1;
						paramName = null;
					}
				}
			}

			// Handle the last parameter if it exists
			if (valueStart !== -1 && depth === 0) {
				let valueEnd = constructorArgs.length;
				while (valueEnd > valueStart && /[\s,)]/.test(constructorArgs[valueEnd - 1])) {
					valueEnd--;
				}

				while (valueStart < valueEnd && /\s/.test(constructorArgs[valueStart])) {
					valueStart++;
				}

				const paramStartPos = editor.document.positionAt(searchStartOffset + valueStart);
				const paramEndPos = editor.document.positionAt(searchStartOffset + valueEnd);

				params.push({
					name: paramName,
					start: paramStartPos,
					end: paramEndPos
				});
			}

			if (params.length > 0) {
				navigableElements = params;
				console.log('Using parsed parameters:', params.map(p => ({
					name: p.name,
					range: {
						start: `${p.start.line}:${p.start.character}`,
						end: `${p.end.line}:${p.end.character}`
					}
				})));

				// Skip the rest of the processing and go straight to navigation
				if (navigableElements.length > 0) {
					let nextIndex = -1;

					if (editor.selection.isEmpty) {
						const currentElemIndex = navigableElements.findIndex((elem, index) => {
							const nextElem = index < navigableElements.length - 1 ? navigableElements[index + 1] : null;
							const rangeEnd = nextElem ? nextElem.start : elem.end;

							const isInRange = position.line >= elem.start.line && position.line <= rangeEnd.line &&
								(position.line !== elem.start.line || position.character >= elem.start.character) &&
								(position.line !== rangeEnd.line || position.character <= rangeEnd.character);

							if (isInRange) {
								console.log(`Cursor is within element ${index}`);
							}
							return isInRange;
						});

						console.log('Current element index:', currentElemIndex);

						if (forward) {
							if (currentElemIndex !== -1) {
								nextIndex = (currentElemIndex + 1) % navigableElements.length;
								console.log('Moving to next element:', nextIndex);
							} else {
								nextIndex = navigableElements.findIndex(elem => position.isBefore(elem.start));
								if (nextIndex === -1) nextIndex = 0;
								console.log('Moving to nearest next element:', nextIndex);
							}
						} else {
							if (currentElemIndex !== -1) {
								nextIndex = currentElemIndex;
								console.log('Selecting current element:', nextIndex);
							} else {
								nextIndex = findLastIndex(navigableElements, elem => position.isAfter(elem.end));
								if (nextIndex === -1) nextIndex = navigableElements.length - 1;
								console.log('Moving to nearest previous element:', nextIndex);
							}
						}
					} else {
						// Selection handling with logging
						const currentIndex = navigableElements.findIndex(elem =>
							elem.start.isEqual(editor.selection.start) && elem.end.isEqual(editor.selection.end));
						console.log('Current selection index:', currentIndex);

						if (currentIndex !== -1) {
							if (forward) {
								nextIndex = (currentIndex + 1) % navigableElements.length;
								console.log('Moving selection to next:', nextIndex);
							} else {
								nextIndex = (currentIndex - 1 + navigableElements.length) % navigableElements.length;
								console.log('Moving selection to previous:', nextIndex);
							}
						}
					}

					if (nextIndex !== -1) {
						const nextElement = navigableElements[nextIndex];
						console.log('Final navigation target:', {
							index: nextIndex,
							start: `${nextElement.start.line}:${nextElement.start.character}`,
							end: `${nextElement.end.line}:${nextElement.end.character}`
						});

						editor.selection = new vscode.Selection(nextElement.start, nextElement.start);
						editor.selection = new vscode.Selection(nextElement.start, nextElement.end);
						editor.revealRange(new vscode.Range(nextElement.start, nextElement.end));
					}
					return; // Exit early after navigation
				}
			}
		}
	}

	if (!editor.selection.isEmpty) {
		console.log('Has selection:', {
			start: editor.selection.start,
			end: editor.selection.end
		});
		const exactNode = findExactNode(outline, editor.selection.start, editor.selection.end);
		if (exactNode) {
			parentNode = findParentNodeExcludingCurrent(outline, exactNode) || currentNode;
			console.log('Found exact parent node:', {
				kind: parentNode.element.kind,
				name: parentNode.element.name
			});
		}
	}

	console.log('Parent node kind:', parentNode.element.kind);
	console.log('Parent node children:', parentNode.children?.map(child => ({
		kind: child.element.kind,
		name: child.element.name,
		range: child.range
	})));

	if (parentNode.children) {
		switch (parentNode.element.kind) {
			case 'CONSTRUCTOR_INVOCATION':
				console.log('Processing widget parameters');
				// Get all direct children
				const allChildren = parentNode.children || [];
				console.log('All children:', allChildren.map(c => ({
					kind: c.element.kind,
					name: c.element.name
				})));

				// First try to find direct parameters
				let parameters = allChildren.filter(child =>
					child.element.kind === 'NAMED_ARGUMENT' ||
					child.element.kind === 'ARGUMENT'
				);

				// If no direct parameters found, try to find them in child nodes
				if (parameters.length === 0) {
					parameters = allChildren.flatMap(child =>
						child.children?.filter(grandChild =>
							grandChild.element.kind === 'NAMED_ARGUMENT' ||
							grandChild.element.kind === 'ARGUMENT'
						) || []
					);
				}

				console.log('Found parameters:', parameters.map(p => ({
					kind: p.element.kind,
					name: p.element.name
				})));

				navigableElements = parameters.map(child => {
					const elem = {
						start: new vscode.Position(child.range.start.line, child.range.start.character),
						end: new vscode.Position(child.range.end.line, child.range.end.character)
					};
					console.log(`Mapped element: ${child.element.name || ''}`, elem);
					return elem;
				});
				break;
			case 'LIST_LITERAL':
				console.log('Processing array elements');
				navigableElements = parentNode.children.map(child => ({
					start: new vscode.Position(child.range.start.line, child.range.start.character),
					end: new vscode.Position(child.range.end.line, child.range.end.character)
				}));
				break;
			case 'CLASS_DECLARATION':
				// Class members
				navigableElements = parentNode.children
					.filter(child => ['FIELD', 'METHOD', 'CONSTRUCTOR'].includes(child.element.kind))
					.map(child => ({
						start: new vscode.Position(child.range.start.line, child.range.start.character),
						end: new vscode.Position(child.range.end.line, child.range.end.character)
					}));
				break;
			case 'COMPILATION_UNIT':
				// File-level declarations
				navigableElements = parentNode.children
					.filter(child => ['CLASS_DECLARATION', 'METHOD_DECLARATION', 'FIELD_DECLARATION'].includes(child.element.kind))
					.map(child => ({
						start: new vscode.Position(child.range.start.line, child.range.start.character),
						end: new vscode.Position(child.range.end.line, child.range.end.character)
					}));
				break;
		}
	}

	console.log('Navigable elements:', navigableElements.map((elem, idx) => ({
		index: idx,
		start: `${elem.start.line}:${elem.start.character}`,
		end: `${elem.end.line}:${elem.end.character}`
	})));

	if (navigableElements.length === 0) {
		console.log('No navigable elements found');
		return;
	}

	let nextIndex = -1;

	if (editor.selection.isEmpty) {
		const currentElemIndex = navigableElements.findIndex((elem, index) => {
			const nextElem = index < navigableElements.length - 1 ? navigableElements[index + 1] : null;
			const rangeEnd = nextElem ? nextElem.start : elem.end;

			const isInRange = position.line >= elem.start.line && position.line <= rangeEnd.line &&
				(position.line !== elem.start.line || position.character >= elem.start.character) &&
				(position.line !== rangeEnd.line || position.character <= rangeEnd.character);

			if (isInRange) {
				console.log(`Cursor is within element ${index}`);
			}
			return isInRange;
		});

		console.log('Current element index:', currentElemIndex);

		if (forward) {
			if (currentElemIndex !== -1) {
				nextIndex = (currentElemIndex + 1) % navigableElements.length;
				console.log('Moving to next element:', nextIndex);
			} else {
				nextIndex = navigableElements.findIndex(elem => position.isBefore(elem.start));
				if (nextIndex === -1) nextIndex = 0;
				console.log('Moving to nearest next element:', nextIndex);
			}
		} else {
			if (currentElemIndex !== -1) {
				nextIndex = currentElemIndex;
				console.log('Selecting current element:', nextIndex);
			} else {
				nextIndex = findLastIndex(navigableElements, elem => position.isAfter(elem.end));
				if (nextIndex === -1) nextIndex = navigableElements.length - 1;
				console.log('Moving to nearest previous element:', nextIndex);
			}
		}
	} else {
		// Selection handling with logging
		const currentIndex = navigableElements.findIndex(elem =>
			elem.start.isEqual(editor.selection.start) && elem.end.isEqual(editor.selection.end));
		console.log('Current selection index:', currentIndex);

		if (currentIndex !== -1) {
			if (forward) {
				nextIndex = (currentIndex + 1) % navigableElements.length;
				console.log('Moving selection to next:', nextIndex);
			} else {
				nextIndex = (currentIndex - 1 + navigableElements.length) % navigableElements.length;
				console.log('Moving selection to previous:', nextIndex);
			}
		}
	}

	if (nextIndex !== -1) {
		const nextElement = navigableElements[nextIndex];
		console.log('Final navigation target:', {
			index: nextIndex,
			start: `${nextElement.start.line}:${nextElement.start.character}`,
			end: `${nextElement.end.line}:${nextElement.end.character}`
		});

		editor.selection = new vscode.Selection(nextElement.start, nextElement.start);
		editor.selection = new vscode.Selection(nextElement.start, nextElement.end);
		editor.revealRange(new vscode.Range(nextElement.start, nextElement.end));
	} else {
		console.log('No navigation target found');
	}
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
