# electron-builder build artifact

`winCodeSign-2.6.0.7z` is the upstream electron-builder binary artifact used by
electron-builder 24.13.3 to edit Windows executable icons and version metadata.

- Upstream name: `winCodeSign-2.6.0.7z`
- Upstream URL: `https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z`
- SHA-256: `cdaec7154dda7cc31f88d886e2489379a0625a737d610b5ae7f62a12f16743a4`
- SHA-512: `e8b408d9df413c2dd7b346684d07b5a37b4f880dbc73bf8f63af50f62fe90fc958e39a6c32d1ee2f0bf7bd1724895af7671d5c6cdc8b94147c493c0275c1f0b4`

The archive contains two macOS symbolic links. Windows accounts without the
`SeCreateSymbolicLinkPrivilege` cannot extract them with app-builder's default
command. `scripts/lib/builder-cache.js` verifies this archive, excludes those
two link entries, copies their targets as regular files, verifies the complete
83-file canonical tree, and exposes only the generated `tmp/` cache to
electron-builder. Windows resource editing remains enabled.
