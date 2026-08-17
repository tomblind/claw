// Shared by the CLI and the core. On a mismatch (plugin updated while an old
// core is still running) the CLI restarts a bare core itself, or asks the
// user to relaunch the app when the app owns the running core.
export const VERSION = '0.22.0'
