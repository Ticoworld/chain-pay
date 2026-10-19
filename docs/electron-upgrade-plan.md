# Electron security upgrade

Status: in progress (2026-10-19). Release gate: complete the runtime checks below before packaging or distributing a desktop build.

## Target and reason

The previous desktop pin was Electron 33. Electron supports only its three newest stable major lines. On 2026-10-19 those are 42, 43, and 44; 45 is scheduled for 2026-10-20. Electron 33 is outside support, and the older context-isolation and contextBridge defects recorded on the ChainPay Kanban board affect the boundary around the local keystore signer.

The upgrade branch pins exact version 44.4.5, released more than 14 days before this plan, to respect the repository's dependency cooldown. Before any release, review subsequent 44.x security fixes and pin a patched version that has completed the same checks. Reassess the target if 45 becomes stable before release.

The production renderer now loads from a localhost HTTP server bound to `127.0.0.1` on a stable per-profile port. This preserves the IndexedDB/OPFS origin between restarts. It serves only bundled assets and SPA routes, checks the Host header, and sets CSP, COOP, COEP, CORP, and `nosniff` response headers. A `file://` preview could not mount the router or expose `SharedArrayBuffer`; a custom scheme mounted the router but did not provide cross-origin isolation. A production-bundle preview with the localhost server reported `crossOriginIsolated: true`, `SharedArrayBuffer` available, and light-client peer connection. Two Linux Xvfb launches on 2026-10-19 used the same `127.0.0.1:35406` origin and both connected light-client peers. An unpacked Linux build initially failed because the keyvault WASM was absent; the build now copies the JS and WASM into app resources, and the packaged app serves the ChainPay page with HTTP 200 on its stable profile origin.

Packaged Linux persistence smoke on 2026-10-19 used a throwaway `XDG_CONFIG_HOME` and two separate launches. A DevTools Protocol check wrote `persisted-across-restart` into IndexedDB on the first launch and read the same marker on the second. Both launches reported origin `http://127.0.0.1:30303`, `crossOriginIsolated: true`, and `SharedArrayBuffer` as a function. This proves the packaged renderer's browser storage survives restart for that profile; a real light-client database upgrade and keystore signing still need manual checks.

The change from `file://` to localhost also changes the browser storage origin. A packaged startup now opens a script-free file page in the existing Electron profile, reads only `chain-pay:` app keys and `chainpay.ckb.lc.secret-key.` light-client identity keys, then copies missing entries into localhost storage before loading the app. It leaves both existing localhost values and the old file-origin data untouched. A throwaway Electron 33 packaged app created a file-origin light-client database and pairing root; upgrading that same profile in place to the Electron 44 packaged app preserved the light-client identity, set the migration marker, initialized new localhost light-client databases, kept `crossOriginIsolated` and `SharedArrayBuffer`, and served `/health` from the local pairing server with HTTP 200. The old IndexedDB/OPFS chain index is not copied. Database initialization does not prove a complete chain resync; verify watched-script registration, sync completion, and keyvault signing on an upgraded profile before release. Returning to an older binary after migration is not a supported write path.

The window now rejects navigation outside its renderer origin and only opens HTTP(S) destinations through the OS browser. This keeps a link from moving the privileged app window onto a remote page.

Official references: [release support policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines), [schedule](https://releases.electronjs.org/schedule), [breaking changes](https://www.electronjs.org/docs/latest/breaking-changes), [44.0 release notes](https://releases.electronjs.org/release/v44.0.0).

## Migration checks

1. Update the Electron package and lockfile without changing the renderer trust model. Electron's download helper now requires Node 22.12 or newer for installation, so update the repository engine floor and CI runtime. Keep `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and the CJS preload.
   Electron Builder 25's older transitive `node-abi` could not identify Electron 44. The root now pins cooled-down `node-abi` 3.96.0 so the native rebuild stage and packaged Linux build complete.
2. Run typecheck, lint, shared/mobile/desktop unit tests, and a production desktop build.
3. Launch a packaged or production-preview desktop build on Linux. Confirm the preload bridge loads, the dashboard mounts, and no console/CSP errors appear.
4. Confirm the embedded light client starts with COOP/COEP, `SharedArrayBuffer`, workers, and persistent browser storage. Check the network switch and recovery from an existing profile.
5. Confirm the local-keystore path never sends seed/private key material over IPC. Exercise create/import, unlock, sign, export, change-password, rate limiting, and failure handling on a throwaway testnet vault. Confirm the transaction digest and source lock-args checks remain effective.
6. Confirm mobile pairing uses the pinned HTTPS channel, cert rotation, and pair-server startup/shutdown on the upgraded runtime.
7. Smoke the payment UI, file dialogs, downloads/export, external links, and second-instance behavior. Record OS/version and observed results; repeat on macOS and Windows before distributing those builds.

## Platform consequences

Electron 44 drops macOS 12 support; supported macOS builds need macOS 13 or later. The app currently sets `target: "node20"` for its main bundle; this is a compilation target, not the bundled Node runtime. Verify the generated main and preload bundles under Electron 44's Node 24 runtime before changing that build target.

The exact product runtime is not proven upgraded by package tests alone. The release gate remains open until the runtime and signing checks above pass on the intended platforms.
