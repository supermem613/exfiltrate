# Exfiltrate

> Copy the currently open file from a remote VS Code session to your local filesystem — with one click.

## Why

When connected to a remote environment (WSL, Dev Container, SSH, or GitHub Codespaces), saving files to your **local** machine requires jumping through terminal hoops. Exfiltrate puts a simple sidebar panel in VS Code so you can pick a local destination folder and hit **Copy File** — done.

## Features

- **Sidebar panel** in the Activity Bar with live display of the active source file
- **Destination folder input** with a `…` browse button that opens a folder picker on your *local* filesystem, even when the editor is connected to a remote
- **Overwrite prompt** — asks before clobbering an existing file
- Works with all remote types: **WSL**, **Dev Container**, **SSH Remote**, **GitHub Codespaces**, and plain local workspaces
- Persists the last-used destination folder across sessions

## Getting Started

1. Install the extension.
2. Open the **Exfiltrate** panel in the Activity Bar (look for the download icon).
3. Open any file in the editor — its path appears in the **Source File** row.
4. Enter or browse for a **Destination Folder** on your local machine.
5. Click **Copy File**.

That's it. A toast notification confirms the copy, and the status row in the panel shows the result.

## Commands

| Command | Description |
|---|---|
| `Exfiltrate: Copy Current File to Local` | Copy the active editor's file using the configured destination |
| `Exfiltrate: Open Panel` | Reveal the Exfiltrate sidebar panel |
| `Exfiltrate: Show Logs` | Open the Exfiltrate output channel for diagnostic logs |

## Settings

| Setting | Default | Description |
|---|---|---|
| `exfiltrate.destinationPath` | `""` | Local folder on the host machine to copy files into |

You can also set this directly from the VS Code Settings UI (`Ctrl+,` → search *Exfiltrate*).

## How It Works

Exfiltrate reads the source file via `vscode.workspace.fs` — which works transparently across all remote extension hosts — and writes to the local filesystem using either:

- The standard `vscode.Uri.file()` path for local / WSL sessions, or
- The `vscode-local:` URI scheme for true remote contexts (SSH, Codespaces, Dev Containers on non-localhost), which instructs VS Code to write the file on the *UI* (local) host.

## Publishing

Run `vsce package`.

## Development

```bash
npm install
npm run compile        # one-shot build
npm run watch          # incremental build
```

Press **F5** in VS Code to launch an Extension Development Host.

## License

MIT
