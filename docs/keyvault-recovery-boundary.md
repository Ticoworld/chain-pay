# Local wallet recovery boundary

The local BIP39 wallet is available only for the non-treasury CKB send path. Its encrypted vault and recovery words belong to Electron main. The renderer may send passwords and receives only the vault ID, public lock args, and operation status.

## Recovery flows

- **Create:** main generates the encrypted vault and displays the 12 words in a native dialog. It saves the vault after the dialog closes. The words do not enter renderer state or an IPC response.
- **Import:** the user copies 12 or 24 words and selects **Import from clipboard**. Main reads and immediately clears the system clipboard, validates the phrase through the keyvault WASM, and creates an encrypted vault. The import IPC request contains only the password. Operating-system clipboard history may retain copies; the UI warns about this.
- **Back up again:** after password verification, main displays the words in a native dialog and returns `{ ok: true }` over IPC.
- **Delete:** main verifies the vault password before removing the encrypted blob. Create and import refuse to replace an existing vault, including if another process wins the file creation race.

The native dialog and clipboard are operating-system surfaces. Keep the recovery words offline and away from screen capture or clipboard-history tools. The local wallet remains excluded from treasury and multisig signing.

## Verification

`keyvault-recovery-ipc.test.ts` exercises the real WASM package with temporary vault directories. It checks that create and export return no words, import rejects a renderer-supplied mnemonic, the clipboard is cleared before derivation and after invalid input, existing vaults cannot be overwritten, and deletion requires the password. `keyvault-store.test.ts` covers exclusive file creation. The desktop test suite, typecheck, lint, production build, and packaged recovery smoke should be run before merging a change to these flows.
