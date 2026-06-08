import * as vscode from 'vscode';
import * as path from 'path';

/** Uri 的文件名（含扩展名），如 a/b/c.png → c.png */
export function uriBaseName(uri: vscode.Uri): string {
	return uri.path.split('/').filter(Boolean).pop() ?? uri.path;
}

/** Uri 的文件名（去扩展名），如 a/b/c.md → c */
export function uriStem(uri: vscode.Uri): string {
	return path.basename(uri.path, path.extname(uri.path));
}
