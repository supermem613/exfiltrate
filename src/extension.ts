import * as vscode from 'vscode';
import { CopyPanelProvider } from './copyPanel';
import { createLogger } from './logger';

export function activate(context: vscode.ExtensionContext) {
    const logger = createLogger();
    context.subscriptions.push(logger);
    logger.info('Exfiltrate extension activated', {
        remoteName: vscode.env.remoteName,
        uiKind: vscode.env.uiKind,
    });

    const provider = new CopyPanelProvider(context.extensionUri, logger);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(CopyPanelProvider.viewType, provider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('exfiltrate.showLogs', () => {
            logger.show(true);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('exfiltrate.copyFile', async () => {
            await provider.copyActiveFile();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('exfiltrate.showPanel', async () => {
            await vscode.commands.executeCommand('workbench.view.extension.exfiltrate-panel');
        })
    );
}

export function deactivate() {}
