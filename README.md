# ChainPay

Crypto-native payroll & accounting suite. CKB and EVM multisig treasuries, **embedded WASM CKB light client** in the desktop app, and external treasury signers. A scoped local keystore supports single-signature CKB sends.

> [!NOTE]
> The CKB path is shipped end-to-end on testnet: multisig payroll, single-sig
> JoyID sends, PQ-secure signature relay, invoice ingest, and server-derived
> ERPNext journal posting. The Sepolia Safe path now runs through native-ETH
> execution and retry-safe ERPNext posting; additional signers and networks remain.

## Why ChainPay exists

Existing crypto payroll tools fall into one of two buckets:

1. **Custodial SaaS** — your payroll provider holds the keys. Convenient, defeats the entire point of crypto.
2. **Hand-rolled multisig + spreadsheets** — non-custodial but no payroll workflow, no journal entries, no compliance exports.

ChainPay aims to be the middle ground: a desktop app that lets a small org run payroll from a self-custodied multisig treasury, post every confirmed payment as a journal entry into ERPNext / Frappe HR, and ship compliance exports — without holding treasury private keys or trusting an Infura-style CKB RPC provider.

The trust-minimisation half is the differentiator. The CKB light client is **embedded directly inside the desktop app** as a WASM bundle and verifies mainnet headers itself. There is no `wss://my-favourite-rpc-provider.com` in the loop. See [docs/light-client-integration.md](docs/light-client-integration.md) for the full architecture.

## Design pillars (these constrain every decision)

1. **Treasury keys stay external.** CKB multisig signers use external ckb-cli keystores; EVM Safe owners use external MetaMask or WalletConnect wallets. ChainPay coordinates partial signatures. The only local-key exception is an encrypted BIP39 keystore for non-treasury, single-signature CKB sends. It signs inside Electron main after checking the transaction digest and source lock args; key material never crosses renderer IPC.
2. **Light client first.** Tempted to call a third-party RPC? Stop. Use the embedded light client. Remote RPC is a fallback config flag, not the default.
3. **Multisig is the trust root.** MetaMask is a signer *transport*, not a treasury. Safe is the EVM treasury. `secp256k1_blake160_multisig_all` is the CKB treasury.
4. **Adapters stay adapters.** All chain code lives behind the `ChainAdapter` / `SignerTransport` interfaces. Payroll, treasury, and accounting logic must never know whether a chain is CKB or EVM.
5. **Every confirmed payment posts a journal entry.** Salary expense debit, treasury asset credit, network fee expense, FX gain/loss. Bookkeepers should never have to reconcile a chain explorer.

## Status

| Phase | Theme | State |
|---|---|---|
| 0 | Repo scaffold | ✅ done |
| 1 | Embedded CKB light client (renderer-owned, WASM, browser-storage) | ✅ done — verified live on mainnet, peers attach within ~30 s |
| 2 | CKB multisig treasury (setup wizard, address derivation, tx builder, JoyID→ckb-cli signer pivot) | ✅ done — first confirmed testnet tx `0x4e66d1…0e92` on block 21,161,590 (2026-05-21) |
| 2.5 | Payroll batch over CKB multisig (N-output tx, FX snapshot, approval queue, status machine) | ✅ done — first confirmed multi-input testnet batch `0x69ebf7…3b4e1` on block 21,176,012 (2026-05-23) |
| 2.7a–b | Comm channel: on-chain encrypted signature relay (CEMP-PQ — ML-DSA + ML-KEM, Profile Cells, ack loop) | ✅ done — PRs #1–#4 merged; first confirmed A↔B testnet roundtrip 2026-05-24 |
| 2.7c | Mainnet plumbing, network-switch UX, auto-broadcast with 5s countdown, lifecycle-bound retry | ✅ done — PR #6 merged `d090354` (2026-05-29); fast-path manual smoke surfaced and fixed 4 bugs (preload namespace, missing `app.quit` IPC, hooks-rules in mainnet-conditional renders) |
| 3a | Invoice ingest — manual entry + payee flow, vendor flow, draft autosave, approve-and-queue, batch↔invoice confirmation sync | ✅ done — PR #7 merged `8a3b426` (2026-05-29); shell-level smoke clean on `main` |
| 3b–c | Invoice ingest — OCR extraction, multi-invoice bundling, optional Surya backend | ✅ implemented; real-document smoke playbooks remain |
| 3 (EVM) | EVM (Safe) treasury — external owner signers | 🟡 Slices A–E implemented: Sepolia monitoring, MetaMask + WalletConnect approvals, cross-instance interchange, execution, confirmation, and ERPNext accounting; live two-instance gate remains |
| 4 | Frappe accounting bridge — persisted confirmed payments → server-derived journal entries | ✅ CKB + Sepolia Safe + finalized SOL + finalized BTC paths, immutable source records and idempotent JEs |
| 5+ | BTC, SOL, fiat ramps, mobile signer companion | 🟡 BTC A/A2/A3 and SOL B1/B2A/B2B implemented; fiat ramps remain |

Detailed roadmap: [docs/mvp-roadmap.md](docs/mvp-roadmap.md). Phase-specific notes: [PHASE-1.md](PHASE-1.md). Comm-channel design (CEMP-PQ integration): [docs/comm-channel-design.md](docs/comm-channel-design.md).

### What's actually working

| Capability | Where | Evidence |
|---|---|---|
| Embedded CKB light client on mainnet | renderer-side WASM, `src/lib/light-client/` | Tip block + peers update live; no third-party RPC required |
| 2-of-3 multisig treasury — propose, sign, broadcast, confirm | `src/features/treasury/`, `src/lib/chains/ckb/multisig.ts` | Testnet tx `0x4e66d1…0e92` (single-input, 2026-05-21) |
| N-output payroll batch from multisig | `src/features/payroll/`, `packages/shared/src/payroll.ts` | Testnet tx `0x69ebf7…3b4e1` (multi-input, 2026-05-23) — surfaced the witness-padding digest-divergence trap, now fixed |
| Post-quantum signature relay (CEMP-PQ) | `packages/cemp-pq/`, `src/features/sign/` | First confirmed A↔B roundtrip 2026-05-24; ML-DSA + ML-KEM; comm keys segregated from multisig signers by design |
| Invoice ingest (manual entry, both flows) | `src/features/invoices/` | 450 tests green on `main` post-merge; routes verified on shell smoke |
| Mainnet network switch (UX only, no real-fund tx yet) | `src/features/settings/NetworkSection.tsx`, `electron/main/network-state-store.ts` | Manual smoke 2026-05-29: testnet → mainnet → soft-fail UX → testnet round-trip with LC IDB wipe |
| CKB → ERPNext accounting recovery | `crypto_payroll.api.post_confirmed_payment`, desktop accounting host | Confirmed tx `0xdbafdf…ae2a` recovered at USD 0.50; submitted JE `ACC-JV-2026-00023`; source records and tx hashes now idempotency-bound |
| Sepolia Safe → ERPNext accounting recovery | `evm-safe-accounting.ts`, `crypto_payroll.api.post_confirmed_payment` | SafeTx + outer hash are independently idempotent; receipt gas is retained as executor-paid audit metadata and excluded from the Safe treasury credit |
| Bitcoin manual broadcast → ERPNext recovery | `bitcoin-broadcast.ts`, `bitcoin-provider.ts`, `bitcoin-accounting.ts` | Per-output v2 intent, exact raw transaction/block evidence at 6 confirmations, deterministic source record, idempotent journal retry, and reorg reconciliation without rebroadcast |
| ERPNext compliance export | `crypto_payroll.api.export_compliance`, desktop Reports screen | Server-owned CKB/Sepolia evidence exports as deterministic CSV/PDF; Electron verifies SHA-256 before saving |
| WalletConnect Safe approvals | `walletconnect-safe-owner.ts`, `safe-approval-interchange.ts` | Sepolia-only restored sessions, live-owner checks, exact EIP-712 signing, and strict signature-only files for two-instance threshold collection |

### Why the JoyID → ckb-cli signer pivot

Phase 2 originally planned JoyID as the first signer transport. Discovery during Phase 2 bring-up: JoyID's passkey-derived keys are structurally incompatible with `secp256k1_blake160_multisig_all` — the underlying signature primitive doesn't match what the multisig system script verifies. JoyID stays in the SignerTransport interface for non-multisig (single-sig) flows; ckb-cli keystore became the first working multisig signer. See [auto-memory note](./.remember/) for the full rationale.

## Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│  Electron main                                              │
│  ├── BrowserWindow (COOP/COEP + CSP headers, DevTools)      │
│  └── stdout mirror for renderer console                     │
└─────────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│  Electron renderer (React + Vite)                           │
│                                                             │
│  features/         dashboard, treasury, payroll, payments…  │
│       │            (UI, never touches chain primitives)     │
│       │                                                     │
│  lib/chains/       ChainAdapter — ckb, evm; btc/sol stubs   │
│       │                                                     │
│  lib/signers/      SignerTransport — JoyID, MetaMask, etc.  │
│       │                                                     │
│  lib/light-client/ ╔══════════════════════════════════════╗ │
│                    ║  @nervosnetwork/ckb-light-client-js  ║ │
│                    ║  ├── lightclient.worker (sync+RPC)   ║ │
│                    ║  └── db.worker (OPFS/IndexedDB)      ║ │
│                    ╚══════════════════════════════════════╝ │
└─────────────────────────────────────────────────────────────┘

Accounting: ─────────────► HTTP ────────────────►
                           Frappe + ERPNext + crypto_payroll
                           (journal entries, payslips, exports)
```

### Why the light client runs in the **renderer**, not Electron main

The original plan had it in main with an IPC bridge. The reversal was forced: `@nervosnetwork/ckb-light-client-js` requires Web Workers, `SharedArrayBuffer`, and a browser storage backend (the bundled `ckb-light-client-db-worker` writes to OPFS / IndexedDB). Electron main is Node.js — none of those exist there.

Trade-off accepted: no caller-controlled store path. Electron's per-app IndexedDB partition gives equivalent isolation to a file under `userData/`.

### Five runtime ceremonies needed to make the WASM light client run

None of these are obvious from the package's README alone. All are documented in [docs/light-client-integration.md](docs/light-client-integration.md):

1. **COOP/COEP response headers** (`SharedArrayBuffer` requirement).
2. **CSP allowing `blob:` workers + `'wasm-unsafe-eval'`** — strict `script-src 'self'` silently refuses every worker; the client appears to "start then stop" with no error message.
3. **Preload bundle must be CJS** — `sandbox: true` in BrowserWindow forbids ESM preload.
4. **Custom TOML config is mandatory** — the WASM defaults only ship IP-only bootnodes on port 8114; browsers can't open WSS to a raw IP. Use the canonical `*.ckb.guide:443` WSS bootnode list.
5. **A stub `[rpc]` block is required in the TOML** — the embedded Rust serde deserializer fails with `missing field 'rpc'` even though the WASM build never binds an RPC port.

If you're porting this WASM bundle into any other Electron / Tauri / browser app, save yourself the day of debugging and skim the doc first.

## Tech stack

| Layer | Tool |
|---|---|
| Desktop shell | Electron 33 (electron-vite) |
| Frontend | React 19 + Vite 5 + TypeScript |
| UI | Tailwind v4 |
| State | TanStack Query + Zustand |
| Forms | (useState today; React Hook Form + Zod once forms get complex) |
| Tables / charts | TanStack Table + Recharts |
| Tests | Vitest + @vitest/coverage-v8 |
| CKB | embedded `@nervosnetwork/ckb-light-client-js` (WASM) + `@ckb-ccc/core` for tx construction |
| EVM | viem + wagmi + `@safe-global/protocol-kit` (Sepolia Safe slices A–E implemented; live two-instance gate remains) |
| Backend | ERPNext + custom `crypto_payroll` Frappe app |
| DB (backend) | MariaDB via Frappe |

## External dependencies that materially shape the architecture

These are not just dependencies — they constrain how ChainPay is built. Anything else is replaceable; these aren't.

### `@nervosnetwork/ckb-light-client-js` (v0.5.5+)

The reason ChainPay can offer self-custody read access. CKB is the only chain in our adapter set with both a WASM-portable light client and a small enough storage footprint to ship in a desktop app. There is no equivalent for EVM (Helios is close but not production-stable), no equivalent for BTC at WASM-embeddable scale, and Solana fundamentally requires a full node for trust-minimised access.

This asymmetry — CKB gets first-class self-custody, EVM gets best-effort RPC — is the product's strongest differentiator and worth more than the "all chains equal" optical wins.

Underlying Rust crate: [`ckb-light-client`](https://github.com/nervosnetwork/ckb-light-client). Storage-backend benchmark that informed the JS bundle's footprint: see `~/ckb-wallet/research/ckb-light-client/raw/lite-sqlite-findings.md` (RocksDB 132 MB vs SQLite 2.4–5.8 MB at parity correctness).

### `@ckb-ccc/core` (v1.12+)

The CKB transaction-construction layer. Used for `Script`/`Address` encoding, multisig-script byte assembly, fee estimation, witness handling, and (later) the tx-builder + completer pipeline. Picked over Lumos because CCC's async-iterator + ScriptInfo model fits the embedded-light-client query pattern much better than Lumos's indexer-centric flow.

ChainPay's multisig encoding (in `apps/desktop/src/lib/chains/ckb/multisig.ts`) is implemented **from spec** rather than reaching for a CCC helper because CCC core doesn't ship a multisig builder — only the `Secp256k1Multisig` `KnownScript` constants for address derivation.

### `@safe-global/protocol-kit` + `@safe-global/api-kit` (Phase 3)

Safe (formerly Gnosis Safe) is the EVM treasury. Its contracts are deployed at the same address across every EVM chain via singleton deployer, so `chainId` determines which network to call, not which contract to use. EIP-712 `SafeTx` typed messages are the canonical signing format; not inventing our own.

### `viem` + `wagmi` (Phase 3)

EVM read calls and signer transport. viem for low-level calls, wagmi for the React hook layer over EIP-1193 providers (MetaMask, WalletConnect, Ledger). Drops `web3.js` and `ethers.js` entirely from the dependency tree.

### Frappe HR + ERPNext (Phase 4)

The accounting backend. Custom `crypto_payroll` app sits inside the Frappe bench at `apps/backend/`. Frappe HR provides payee/employee models, payroll cycles, and payslip generation; ERPNext provides the double-entry GL into which our `accounting_bridge.py` posts journal entries. License compatibility is why this whole repo is GPL-3.0.

### Electron + `electron-vite`

The desktop runtime. electron-vite picked over `electron-builder + webpack` for Vite-native HMR and simpler config. Phase 1 has us running the WASM light client in the renderer with sandbox + contextIsolation enabled; the only main-process responsibility is window lifecycle + CSP/COOP/COEP headers + DevTools.

## Forks and vendored code

**None currently.** Every dependency is consumed from upstream npm with no patches.

The policy when this changes:

- Anything we fork lives under `vendor/<package>/` at the repo root with a top-level `VENDORING.md` recording: upstream version, patch summary, why we couldn't upstream, and a re-evaluation date.
- Cherry-picks via `patch-package` are preferred over vendoring when possible; the patch lives in `patches/` and gets a one-paragraph note in `patches/README.md`.
- If we vendor or patch `@nervosnetwork/ckb-light-client-js` (e.g. to land Phill's pending SQLite-backend PRs), the patch must be reproducible from upstream Git history. No "lost source" patches.

Known candidates for future patching:

- `@nervosnetwork/ckb-light-client-js` — two upstream-pending PRs (WITHOUT-ROWID + multi-block tx batching) speed up the native backend. They don't currently affect the WASM build. Re-evaluate if the WASM `db-worker` adopts equivalent changes.

## Repo layout

```
chain-pay/
├── apps/
│   ├── desktop/                Electron app
│   │   ├── electron/           main + preload processes
│   │   ├── src/
│   │   │   ├── App.tsx         App-level light-client auto-start
│   │   │   ├── features/       one folder per product surface
│   │   │   │   ├── dashboard/  tip block, peer count, sync status
│   │   │   │   ├── treasury/   list, setup wizard, detail, multi-treasury switching
│   │   │   │   ├── payroll/    batch builder, FX snapshot, approval queue, status machine
│   │   │   │   ├── payments/   pay panel — sign / broadcast / track confirmations
│   │   │   │   ├── invoices/   ingest (manual entry), payee + vendor flows (PR #7)
│   │   │   │   ├── sign/       comm-channel signer-side UI (CEMP-PQ relay, ack loop)
│   │   │   │   ├── employees/  (Phase 4 with Frappe)
│   │   │   │   └── settings/   broadcast RPC, treasury switching, debug
│   │   │   ├── lib/
│   │   │   │   ├── chains/     ChainAdapter — ckb, evm; btc/sol stubs
│   │   │   │   │   ├── ckb/    multisig.ts, address.ts, adapter.ts
│   │   │   │   │   └── evm/    safe.ts, adapter.ts
│   │   │   │   ├── signers/    SignerTransport — JoyID, MetaMask, etc.
│   │   │   │   └── light-client/  renderer-side WASM host
│   │   │   ├── stores/         Zustand stores (sync, treasury)
│   │   │   └── components/     layout primitives
│   │   ├── electron.vite.config.ts
│   │   └── vitest.config.ts
│   └── backend/                Frappe bench (Phase 4)
│       └── apps/crypto_payroll/  custom Frappe app skeleton
├── packages/
│   ├── shared/                 cross-cutting types and schemas (payroll, vendors, batches)
│   └── cemp-pq/                CEMP-PQ tx-builder + Profile Cell molecule (ML-DSA / ML-KEM)
├── docs/                       architecture, security, payment flow
│   ├── architecture.md
│   ├── light-client-integration.md
│   ├── ckb-multisig-witness.md
│   ├── comm-channel-design.md         CEMP-PQ relay design (Phase 2.7)
│   ├── crypto-payment-flow.md
│   ├── accounting-model.md
│   ├── api-contract.md
│   ├── security-model.md
│   ├── phase-2-smoke-playbook.md      manual verification scripts
│   ├── phase-2.5-smoke-playbook.md
│   └── mvp-roadmap.md
├── docker/                     Frappe compose + Dockerfile (Phase 4)
├── PHASE-1.md                  current/recent phase deep-dive
├── CLAUDE.md                   AI assistant ground rules
└── README.md
```

## Quick start

```bash
# clone, install
git clone https://github.com/toastmanAu/chain-pay.git
cd chain-pay
npm install

# launch the desktop app with HMR
npm run dev:desktop

# run tests
npm test --workspaces --if-present

# typecheck across all workspaces
npm run typecheck
```

Backend (Frappe `crypto_payroll` app) tests run inside the `chainpay-backend`
container. Test modules live under `crypto_payroll/tests/` and
`crypto_payroll/setup/` — `--app crypto_payroll` walks both:

```bash
# all backend tests (38: 32 API/compliance + 2 chain-vector + 4 setup)
docker exec chainpay-backend bench --site chainpay.localhost run-tests --app crypto_payroll

# a single module
docker exec chainpay-backend bench --site chainpay.localhost run-tests --module crypto_payroll.tests.test_api
docker exec chainpay-backend bench --site chainpay.localhost run-tests --module crypto_payroll.tests.test_chains
```

What to expect on first launch:

1. Window opens, Dashboard route.
2. Sidebar bottom: "CKB light client: starting" → "connecting" → "running".
3. "CKB tip block" tile fills with live mainnet height (~16M+) within ~30 s of bootnode contact.
4. Peer count > 0.

If the sidebar sits at "connecting" past a minute, DevTools console (auto-opens in dev) will tell you why — most likely a CSP / WSS / config issue documented in [docs/light-client-integration.md](docs/light-client-integration.md).

## Trust model

ChainPay **does not store private keys**. Treasuries are multisig:

- **CKB** — `secp256k1_blake160_multisig_all` system script (V1). Lock args = `blake160(S|R|M|N|pubkey_hashes...)` optionally `|| since(8)` for time-locked spends. Co-signers sign with their own wallet (JoyID, Ledger, ckb-cli keystore). See [docs/ckb-multisig-witness.md](docs/ckb-multisig-witness.md).
- **EVM** — Safe v1.4 contract. Owners sign EIP-712 `SafeTx` typed messages with their own wallet (MetaMask, WalletConnect, Ledger, Frame). Phase 3.

MetaMask is a **signer transport**, not a treasury. Safe is the multisig.

ChainPay v0.x specifically uses **`Secp256k1Multisig` V1** (`code_hash 0x5c5069eb...634e2a8`, `hashType "type"`) rather than V2 (`data1`), because every existing CKB signer wallet — JoyID, Ledger, ckb-cli, Neuron — already knows how to construct V1 witnesses. V2 is technically nicer (immutable code) but our co-signers' wallets would silently fail to sign.

Security model details: [docs/security-model.md](docs/security-model.md).

## Tested

```
Test Files  47 across desktop + shared + cemp-pq
     Tests  465 passed (on feat/phase-3a-invoice-ingest at 24a0bd0)
   Surface  multisig encoding · address derivation · payroll batch state machine ·
            FX snapshot · CEMP-PQ tx builder · vendor + invoice flows ·
            treasury/payee/clipboard/debug-settings stores
```

Trust-critical encoding and state-machine logic carry the heaviest coverage; UI components are exercised through store-level tests plus manual smoke playbooks (`docs/phase-2-smoke-playbook.md`, `docs/phase-2.5-smoke-playbook.md`). Two-stage review (per-task TDD + whole-branch tsc + cross-task review) caught three seam bugs during Phase 2.7c — see `subagent-driven-cross-task-bugs` in auto-memory.

## Engineering process

Phases 2.7c and 3a were executed via **subagent-driven development** — 24 discrete TDD tasks per phase, each landing as its own commit, then a final whole-branch review pass before PR. This is the pattern documented in the `superpowers:subagent-driven-development` skill and has caught cross-task integration bugs that per-task tests miss (React 19 Strict Mode double-effects, treasury v1→v2 migration backfill, witness-padding digest divergence under multi-input multisig).

For domain-specific traps when touching CKB tx construction, see `~/.claude/rules/ckb-transactions.md` — feedback log entries from this repo include the multi-input witness-padding fix (2026-05-24) and the molecule self-size trap.

## License

GPL-3.0-or-later — inherited from the ERPNext / Frappe HR ecosystem. ChainPay is intended to be modified and deployed by the orgs that use it; copyleft fits.

## Acknowledgements

- The Nervos / CKB team for the only WASM-portable light client in the ecosystem.
- The CCC team for a TypeScript SDK that doesn't fight you.
- The Safe team for making EVM multisig boring and predictable.
- Frappe / ERPNext for being a serious open-source ERP that crypto-native orgs can actually adopt.
