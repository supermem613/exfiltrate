import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { Logger } from './logger';
import {
    detectIsRemoteLocalMachine,
    shouldUseVscodeLocalScheme,
} from './remoteSessionUtils';

type WebviewMessage =
    | { type: 'getState' }
    | { type: 'updateDestination'; path: string }
    | { type: 'browse' }
    | { type: 'copy'; destination: string };

export class CopyPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'exfiltrate.panelView';

    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _logger: Logger
    ) {}

    public resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtml();

        webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) =>
            this._handleMessage(msg)
        );

        // Update source display whenever the active editor changes
        vscode.window.onDidChangeActiveTextEditor(() => this._sendSourceUpdate());

        // Push initial state once the view is ready
        this._sendSourceUpdate();
        this._sendDestinationUpdate();
    }

    // -------------------------------------------------------------------------
    // Public API (callable from commands)
    // -------------------------------------------------------------------------

    public async copyActiveFile(destination?: string): Promise<void> {
        const dest =
            destination ??
            vscode.workspace.getConfiguration('exfiltrate').get<string>('destinationPath', '');

        if (!dest) {
            const pick = await vscode.window.showErrorMessage(
                'Exfiltrate: no destination folder configured.',
                'Open Settings'
            );
            if (pick === 'Open Settings') {
                vscode.commands.executeCommand(
                    'workbench.action.openSettings',
                    'exfiltrate.destinationPath'
                );
            }
            return;
        }

        await this._doCopy(dest);
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private _sendSourceUpdate(): void {
        const editor = vscode.window.activeTextEditor;
        const filePath = editor?.document.uri.fsPath ?? '';
        this._view?.webview.postMessage({ type: 'updateSource', path: filePath });
    }

    private _sendDestinationUpdate(): void {
        const config = vscode.workspace.getConfiguration('exfiltrate');
        const destPath = config.get<string>('destinationPath', '');
        this._view?.webview.postMessage({ type: 'updateDestination', path: destPath });
    }

    private async _handleMessage(message: WebviewMessage): Promise<void> {
        switch (message.type) {
            case 'getState':
                this._sendSourceUpdate();
                this._sendDestinationUpdate();
                break;

            case 'updateDestination':
                await vscode.workspace
                    .getConfiguration('exfiltrate')
                    .update('destinationPath', message.path, vscode.ConfigurationTarget.Global);
                this._logger.info('Destination updated', { path: message.path });
                break;

            case 'browse':
                await this._handleBrowse();
                break;

            case 'copy':
                await this._handleCopyFromWebview(message.destination);
                break;
        }
    }

    private async _handleBrowse(): Promise<void> {
        const remoteName = vscode.env.remoteName;
        const isRemoteLocal = detectIsRemoteLocalMachine(remoteName, os.hostname());
        const useLocalScheme = shouldUseVscodeLocalScheme(remoteName, isRemoteLocal);

        this._logger.info('Opening folder browser', { remoteName, useLocalScheme });

        const selected = useLocalScheme
            ? await this._browseViaInputBox()
            : await this._browseViaDialog();

        if (selected) {
            this._logger.info('Folder selected', { path: selected });
            this._view?.webview.postMessage({ type: 'browseResult', path: selected });
            await vscode.workspace
                .getConfiguration('exfiltrate')
                .update('destinationPath', selected, vscode.ConfigurationTarget.Global);
        }
    }

    /**
     * In a true remote context (Codespaces, ssh-remote, etc.) showOpenDialog
     * cannot browse the local filesystem — it throws "File system provider for
     * vscode-local:/ is not available". Fall back to a typed input box instead.
     */
    private async _browseViaInputBox(): Promise<string | undefined> {
        const saved = vscode.workspace
            .getConfiguration('exfiltrate')
            .get<string>('destinationPath', '');
        return vscode.window.showInputBox({
            title: 'Exfiltrate: Set Destination Folder',
            prompt: 'Enter the full path to a folder on your local machine',
            value: saved,
            ignoreFocusOut: true,
        });
    }

    private async _browseViaDialog(): Promise<string | undefined> {
        const saved = vscode.workspace
            .getConfiguration('exfiltrate')
            .get<string>('destinationPath', '');
        const defaultUri = saved ? vscode.Uri.file(saved) : vscode.Uri.file(os.homedir());
        const result = await vscode.window.showOpenDialog({
            defaultUri,
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'Select Destination Folder',
            title: 'Exfiltrate: Select Destination Folder',
        });
        return result?.[0]?.fsPath;
    }

    private async _handleCopyFromWebview(destination: string): Promise<void> {
        try {
            await this._doCopy(destination);
            const editor = vscode.window.activeTextEditor;
            const filename = editor ? path.basename(editor.document.uri.fsPath) : '';
            const destDisplay = path.join(destination, filename);
            this._view?.webview.postMessage({
                type: 'copyResult',
                success: true,
                message: `Copied to ${destDisplay}`,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this._view?.webview.postMessage({
                type: 'copyResult',
                success: false,
                message: msg,
            });
        }
    }

    private async _doCopy(destDir: string): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            throw new Error('No active file to copy. Open a file first.');
        }

        const sourceUri = editor.document.uri;
        const filename = path.basename(sourceUri.fsPath);

        if (!destDir.trim()) {
            throw new Error('Destination folder is empty. Set a path first.');
        }

        // Log full environment for remote debugging
        const remoteName = vscode.env.remoteName;
        const hostname = os.hostname();
        const platform = os.platform();
        const homedir = os.homedir();
        const isRemoteLocal = detectIsRemoteLocalMachine(remoteName, hostname);
        const useLocalScheme = shouldUseVscodeLocalScheme(remoteName, isRemoteLocal);

        this._logger.info('Copy environment', {
            remoteName: remoteName ?? '(undefined)',
            hostname,
            platform,
            homedir,
            isRemoteLocal,
            useLocalScheme,
            destDir,
            filename,
        });

        const destUri = this._buildDestUri(destDir, filename);

        this._logger.info('Copying file', {
            source: sourceUri.toString(),
            sourceScheme: sourceUri.scheme,
            destination: destUri.toString(),
            destScheme: destUri.scheme,
            destPath: destUri.path,
        });

        // Check for overwrite
        this._logger.info('Checking if destination exists', { uri: destUri.toString() });
        let exists = false;
        try {
            await vscode.workspace.fs.stat(destUri);
            exists = true;
            this._logger.info('Destination exists');
        } catch (statErr: any) {
            this._logger.info('Stat result (expected miss = ok)', {
                code: statErr?.code,
                name: statErr?.name,
                message: statErr?.message,
            });
        }

        if (exists) {
            const answer = await vscode.window.showWarningMessage(
                `"${filename}" already exists in the destination folder. Overwrite?`,
                { modal: true },
                'Overwrite',
                'Cancel'
            );
            if (answer !== 'Overwrite') {
                throw new Error('Copy cancelled.');
            }
        }

        // Read source
        let content: Uint8Array;
        try {
            content = await vscode.workspace.fs.readFile(sourceUri);
            this._logger.info('Source read', { bytes: content.byteLength });
        } catch (err) {
            this._logger.error('Failed to read source file', err);
            throw new Error(`Cannot read source file: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Write to destination
        this._logger.info('Writing to destination', { uri: destUri.toString() });
        try {
            await vscode.workspace.fs.writeFile(destUri, content);
            this._logger.info('Write succeeded');
        } catch (err: any) {
            this._logger.error('Write failed', {
                code: err?.code,
                name: err?.name,
                message: err?.message,
                uri: destUri.toString(),
            });
            // When vscode-local: is not registered (e.g. some Codespaces configs),
            // fall back to the plain file: scheme, mirroring PatchItUp's pattern.
            if (useLocalScheme && (err.code === 'ENOPRO' || err.message?.includes('No file system provider'))) {
                const fallbackUri = vscode.Uri.joinPath(vscode.Uri.file(destDir), filename);
                this._logger.warn('vscode-local: unavailable, falling back to file: scheme', {
                    fallbackUri: fallbackUri.toString(),
                });
                try {
                    await vscode.workspace.fs.writeFile(fallbackUri, content);
                    this._logger.info('Fallback write succeeded', { uri: fallbackUri.toString() });
                } catch (fallbackErr: any) {
                    this._logger.error('Fallback write also failed', {
                        code: fallbackErr?.code,
                        name: fallbackErr?.name,
                        message: fallbackErr?.message,
                        uri: fallbackUri.toString(),
                    });
                    throw new Error(`Cannot write destination: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
                }
            } else {
                throw new Error(`Cannot write destination: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        this._logger.info('File copied successfully', {
            source: sourceUri.toString(),
            dest: destUri.toString(),
            bytes: content.byteLength,
        });

        vscode.window.showInformationMessage(`Exfiltrate: copied "${filename}" → ${destDir}`);
    }

    /**
     * Builds the destination URI, applying the `vscode-local:` scheme when the
     * extension is running inside a true remote (SSH, Codespaces, etc.) and needs
     * to write to the local host filesystem.
     */
    private _buildDestUri(destDir: string, filename: string): vscode.Uri {
        const remoteName = vscode.env.remoteName;
        const isRemoteLocal = detectIsRemoteLocalMachine(remoteName, os.hostname());
        const useLocalScheme = shouldUseVscodeLocalScheme(remoteName, isRemoteLocal);

        // Do NOT use vscode.Uri.file(destDir).with({scheme:'vscode-local'}) here.
        // When the extension host is Linux (Codespaces, ssh-remote) and the local
        // machine is Windows, vscode.Uri.file('C:/temp') encodes the colon:
        //   vscode-local:/c%3A/temp   ← wrong (ENOPRO / provider-not-found)
        //   vscode-local:///c:/temp   ← correct
        const vscodeFileUri = vscode.Uri.file(destDir);
        const naiveWithUri = vscodeFileUri.with({ scheme: 'vscode-local' });
        const correctUri = toVscodeLocalUri(destDir);

        this._logger.info('_buildDestUri', {
            destDir,
            useLocalScheme,
            'vscode.Uri.file()': vscodeFileUri.toString(),
            'naive .with(vscode-local)': naiveWithUri.toString(),
            'toVscodeLocalUri()': correctUri.toString(),
        });

        const baseUri = useLocalScheme ? correctUri : vscodeFileUri;
        return vscode.Uri.joinPath(baseUri, filename);
    }

    private async _fileExists(uri: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch {
            return false;
        }
    }

    // -------------------------------------------------------------------------
    // HTML
    // -------------------------------------------------------------------------

    private _getHtml(): string {
        const nonce = getNonce();
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            padding: 10px 12px 16px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-sideBar-background);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            line-height: 1.4;
        }

        .section { margin-bottom: 10px; }

        .label {
            display: block;
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.6px;
            color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
            margin-bottom: 4px;
            opacity: 0.75;
        }

        .path-display {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 11px;
            padding: 5px 8px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 2px;
            color: var(--vscode-input-foreground);
            word-break: break-all;
            min-height: 26px;
        }

        .path-display.empty {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }

        .input-row {
            display: flex;
            gap: 4px;
            align-items: stretch;
        }

        input[type="text"] {
            flex: 1;
            height: 26px;
            padding: 0 7px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border, transparent);
            color: var(--vscode-input-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            border-radius: 2px;
            outline: none;
        }

        input[type="text"]:focus {
            border-color: var(--vscode-focusBorder);
        }

        input[type="text"]::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }

        button {
            height: 26px;
            padding: 0 9px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 2px;
            cursor: pointer;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            white-space: nowrap;
        }

        button:hover:not(:disabled) {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .browse-btn {
            min-width: 28px;
            font-weight: 600;
            letter-spacing: -1px;
        }

        .divider {
            height: 1px;
            background: var(--vscode-widget-border, var(--vscode-panel-border, #444));
            margin: 10px 0;
            opacity: 0.4;
        }

        .copy-btn {
            width: 100%;
            height: 28px;
            margin-top: 6px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            font-weight: 500;
        }

        .copy-btn:hover:not(:disabled) {
            background: var(--vscode-button-hoverBackground);
        }

        .status {
            margin-top: 8px;
            padding: 6px 8px;
            border-radius: 2px;
            font-size: 11px;
            line-height: 1.4;
            word-break: break-all;
        }

        .status.hidden { display: none; }

        .status.success {
            background: var(--vscode-inputValidation-infoBackground, rgba(0,100,200,0.12));
            border: 1px solid var(--vscode-inputValidation-infoBorder, #007fd4);
        }

        .status.error {
            background: var(--vscode-inputValidation-errorBackground, rgba(200,0,0,0.12));
            border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
            color: var(--vscode-errorForeground, #f14c4c);
        }
    </style>
</head>
<body>
    <div class="section">
        <span class="label">Source File</span>
        <div id="source-path" class="path-display empty">No active file</div>
    </div>

    <div class="divider"></div>

    <div class="section">
        <span class="label">Destination Folder</span>
        <div class="input-row">
            <input type="text" id="dest-input"
                   placeholder="Enter or browse for a local folder path…" />
            <button class="browse-btn" id="browse-btn" title="Browse for destination folder">…</button>
        </div>
    </div>

    <button class="copy-btn" id="copy-btn">Copy File</button>

    <div id="status" class="status hidden"></div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        const sourceEl  = document.getElementById('source-path');
        const destInput = document.getElementById('dest-input');
        const browseBtn = document.getElementById('browse-btn');
        const copyBtn   = document.getElementById('copy-btn');
        const statusEl  = document.getElementById('status');

        // Request initial state from extension
        vscode.postMessage({ type: 'getState' });

        // Browse button
        browseBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'browse' });
        });

        // Persist destination path with a short debounce
        let debounceTimer;
        destInput.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                vscode.postMessage({ type: 'updateDestination', path: destInput.value });
            }, 600);
        });

        // Copy button
        copyBtn.addEventListener('click', () => {
            copyBtn.disabled = true;
            hideStatus();
            vscode.postMessage({ type: 'copy', destination: destInput.value });
        });

        // Messages from extension
        window.addEventListener('message', event => {
            const msg = event.data;
            switch (msg.type) {
                case 'updateSource':
                    if (msg.path) {
                        sourceEl.textContent = msg.path;
                        sourceEl.classList.remove('empty');
                    } else {
                        sourceEl.textContent = 'No active file';
                        sourceEl.classList.add('empty');
                    }
                    break;

                case 'updateDestination':
                    destInput.value = msg.path || '';
                    break;

                case 'browseResult':
                    destInput.value = msg.path;
                    vscode.postMessage({ type: 'updateDestination', path: msg.path });
                    break;

                case 'copyResult':
                    copyBtn.disabled = false;
                    showStatus(msg.success, msg.message);
                    break;
            }
        });

        function showStatus(success, message) {
            statusEl.textContent = message;
            statusEl.className = 'status ' + (success ? 'success' : 'error');
        }

        function hideStatus() {
            statusEl.className = 'status hidden';
        }
    </script>
</body>
</html>`;
    }
}

/**
 * Constructs a `vscode-local:` URI for a local filesystem path without going
 * through `vscode.Uri.file()`, which interprets the path with the REMOTE OS
 * conventions. When the extension host is Linux and the destination is a
 * Windows absolute path (e.g. "C:\temp"), `vscode.Uri.file` encodes the colon:
 *   vscode-local:/c%3A/temp   ← wrong – "No file system provider" error
 *   vscode-local:///c:/temp   ← correct
 */
function toVscodeLocalUri(fsPath: string): vscode.Uri {
    const normalized = fsPath.replace(/\\/g, '/');
    const winDriveMatch = normalized.match(/^([a-zA-Z]):\/?(.*)$/);
    if (winDriveMatch) {
        const drive = winDriveMatch[1].toLowerCase();
        const rest = winDriveMatch[2];
        const uri = vscode.Uri.from({ scheme: 'vscode-local', path: `/${drive}:/${rest}` });
        // logged by caller (_buildDestUri)
        return uri;
    }
    return vscode.Uri.from({ scheme: 'vscode-local', path: normalized });
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
