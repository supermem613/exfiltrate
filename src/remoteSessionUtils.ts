export function isLocalhostHostname(hostname: string): boolean {
    const lower = hostname.toLowerCase();
    return (
        lower === 'localhost' ||
        lower === '127.0.0.1' ||
        lower === '::1' ||
        lower.endsWith('.local') ||
        lower.startsWith('localhost')
    );
}

/**
 * Returns true when the remote is actually running on the same physical machine
 * (WSL, dev-container/ssh-remote with a localhost hostname).
 * Returns false for non-remote sessions, Codespaces, and true remote hosts.
 */
export function detectIsRemoteLocalMachine(
    remoteName: string | undefined,
    hostname: string
): boolean {
    if (remoteName === undefined) {
        return false;
    }

    if (remoteName === 'wsl') {
        return true;
    }

    if (remoteName === 'dev-container' || remoteName === 'attached-container') {
        return isLocalhostHostname(hostname);
    }

    if (remoteName === 'ssh-remote') {
        return isLocalhostHostname(hostname);
    }

    if (remoteName === 'codespaces' || remoteName === 'github-codespaces') {
        return false;
    }

    return false;
}

/**
 * Returns true when the extension is running in a truly remote context and needs
 * the `vscode-local:` URI scheme to access the local host filesystem.
 */
export function shouldUseVscodeLocalScheme(
    remoteName: string | undefined,
    isRemoteLocalMachine: boolean
): boolean {
    return remoteName !== undefined && !isRemoteLocalMachine;
}
