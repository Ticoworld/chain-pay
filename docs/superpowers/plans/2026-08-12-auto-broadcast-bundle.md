# Auto-broadcast bug bundle — implementation plan

> **For agentic workers:** execute task-by-task with a review between each. Steps use checkbox (`- [ ]`) syntax.

**Goal:** fix the five pre-existing PayPanel bugs that the consolidation refactor's new tests surfaced, extract `useAutoBroadcast` (which brings PayPanel under 500 lines), and take the two non-major dependency bumps that matter.

**Why now:** all five were found by tests added in PR #18 and pinned with `BUG PIN` comments rather than fixed, because that branch was contractually behaviour-preserving. Four of them live in or around `onElapsed`, so one bundle fixes them together — and the refactor made that safe by giving `onElapsed` its first coverage.

**Tech stack:** TypeScript / React 19 / Vitest / Zustand · Electron main+renderer.

## Global constraints

- **Each fix changes behaviour deliberately.** Its `BUG PIN` test must be updated to assert the FIXED behaviour, with the pin comment replaced by a note recording what was wrong. Every other test must pass unchanged.
- Gates at every commit: `npm --workspace apps/desktop run lint` → 0 problems · `npm run typecheck` clean · `npm --workspace apps/desktop run test` (baseline `163 files, 1176 passed | 4 skipped`) · backend untouched (`--app crypto_payroll` 38 OK).
- Branch `fix/auto-broadcast-bundle`, off `main` at `c4c369b`. Commit per task. Do not push until the end.
- Files under 800 lines, functions under 50, nesting ≤ 4.

## Ordering rationale

Bug fixes land **before** the `useAutoBroadcast` extraction, so the extraction is gated by a suite that already encodes the corrected behaviour — the same tests-before-refactor discipline that caught the regression in PR #18.

---

### Task A — BUG 4: auto-broadcast pre-checks silently no-op

**The defect.** `AutoBroadcastCountdown.onElapsed` has three pre-checks (missing `broadcastRpcUrl`, no tx bytes, no partial signatures) that each call `batchStore.markBroadcastFailed(...)`. But the batch is still in `broadcast_countdown`, and `lib/payroll/state-machine.ts:26` allows only:

```
broadcast_countdown: ["broadcast_initiating", "approved", "cancelled"]
```

so the store's `canTransition` guard returns the batch untouched. No `broadcastError` is recorded, no state change occurs, and retry (`retryAutoBroadcast`) requires `broadcast_failed → approved`. The UI sits at "Broadcasting in 0…" with no error; the only exit is a button labelled Cancel. An unset `broadcastRpcUrl` is the **default state**, so the first operator to enable auto-broadcast without configuring an RPC URL hits this.

The source comment claims these checks exist "so the user sees a clear error instead of a silent failure" — they do the opposite.

**Files:** `src/lib/payroll/state-machine.ts`, `state-machine.test.ts`, `src/stores/payroll-batches.test.ts`, `src/features/payments/PayPanel.comm.test.tsx`

- [ ] **A1.** Write the failing state-machine test: `canTransition("broadcast_countdown", "broadcast_failed")` must be `true`. Run it, confirm it fails.
- [ ] **A2.** Add `"broadcast_failed"` to `broadcast_countdown`'s allowed list. Confirm the test passes and every other state-machine test still passes — **read the full transition table first** and confirm no other state's invariants depend on `broadcast_countdown` being unable to fail.
- [ ] **A3.** Write a store-level test: a batch in `broadcast_countdown` given `markBroadcastFailed(id, "…")` ends in `broadcast_failed` with `broadcastError` set and `broadcastInFlight` cleared.
- [ ] **A4.** Update the `BUG PIN` test in `PayPanel.comm.test.tsx` covering the missing-`broadcastRpcUrl` path: it must now assert an error is surfaced and the batch reaches `broadcast_failed` (so `retryAutoBroadcast` becomes available), instead of pinning the silent no-op.
- [ ] **A5.** Verify the three pre-check messages still read accurately now that they actually fire. Fix any that don't.
- [ ] **A6.** Run all gates. Commit.

### Task B — BUG 2 and BUG 5: two dead wires in the payments UI

**BUG 2 — the FX refresh and retry buttons do nothing.** `FxSnapshotPanel` types its prop `onRefresh: () => void` and calls `onClick={onRefresh}`, so React passes the `MouseEvent` as the first argument. PayPanel passes `refetchFx(rowsOverride?: RecipientRow[])`, so `rowsOverride` receives the event, `rows` becomes the event, and `rows.map(...)` throws into a swallowed rejection. TypeScript never complained because `(rows?: T[]) => Promise<void>` is assignable to `() => void`. An operator hitting a CoinGecko rate limit has no working retry.

**BUG 5 — comm-relayed signatures never reach the signature UI.** The drain effect calls `batchStore.drainIncomingSigsInto(...)`, which merges into the batch's `partialSigs`, but nothing writes back into the `sigs` React state that `SignaturePanel` renders and that gates "Merge & broadcast". A signature relayed over CEMP-PQ therefore lands on-chain-verified in the store and stays invisible. The auto-broadcast path reads `partialSigs` directly and is unaffected — only the manual path is broken.

Note `drainIncomingSigsInto` already skips slots present in `partialSigs` (`existingSlots`), and `updateSigs` persists operator-typed rows into `partialSigs`. So "never clobber operator input" is already guaranteed at the store layer; the sync only needs to fill in what the drain merged.

**Files:** `src/features/payments/FxSnapshotPanel.tsx`, `PayPanel.tsx`, `PayPanel.batch.test.tsx`, `PayPanel.comm.test.tsx`

- [ ] **B1.** Fix BUG 2 at both call sites: `onClick={() => void onRefresh()}`. Also make the prop type honest — if `onRefresh` is genuinely zero-arg from the panel's perspective, keep `() => void` and rely on the wrapper; do not widen the prop to accept an event.
- [ ] **B2.** Update BUG 2's `BUG PIN` test to assert the refresh actually re-fetches (spy on `fetchCkbPrices`) rather than pinning the swallowed rejection.
- [ ] **B3.** Fix BUG 5: after `drainIncomingSigsInto` reports `merged > 0`, reconcile the batch's `partialSigs` into `sigs` — for each persisted entry set the row at that `slotIndex`, leaving rows the drain did not touch as they are. Use the existing `lifecycle.setSigs`, not a new state path. **Do not route this through `updateSigs`**, which would write straight back to the store and risk a loop; read the reasoning in the code before choosing.
- [ ] **B4.** Update BUG 5's `BUG PIN` test: a buffered comm signature must now appear in the rendered `SignaturePanel` and count toward the M-of-N gate on "Merge & broadcast".
- [ ] **B5.** Add a test that an operator-typed signature in a slot is NOT overwritten when a drain occurs for that same slot.
- [ ] **B6.** Run all gates. Commit.

### Task C — Two truncation/precision defects and two weak tests

- [ ] **C1.** `src/lib/chains/ckb/multisig-assert.ts` — `dumpInputsForInspection` hardcodes `payload.slice(33, 53)`, so on a time-locked treasury (28-byte args including an 8-byte `since`) `__chainpay_debug.expectedLockArgs` silently truncates. During a real `-52` investigation an operator compares that against the chain's 28-byte `lock.args`, sees a mismatch, and wrongly concludes config drift. The guard in the same file uses open-ended `slice(33)` and is `since`-safe. Change to `slice(33)`.
- [ ] **C2.** Strengthen the two weak assertions in `multisig-assert.test.ts` flagged by review: the length-guard case uses an 8-byte lock (56 bytes under threshold) and every fixture is `n=3`, so it cannot distinguish `4 + 20*cfg.n` from `20*cfg.n` or `4 + 20*cfg.m` — add a boundary case at exactly `4 + 20*n - 1` and one non-`n=3` config. And the `__chainpay_debug` test asserts only the SHAPE of `expectedLockArgs`, so `slice(0, 20)` would pass — assert the VALUE: `toBe("0x" + bytesHex(lockArgsFromConfig(CFG)))`. Do C2 **before** C1 so the strengthened test demonstrates the truncation fix.
- [ ] **C3.** `PayPanel.tsx:~102` hydrates `amountCkb` via `(Number(v) / Number(SHANNONS_PER_CKB)).toString()`. For 1–99 shannons that yields exponential notation (`"1e-8"`), which `ckbToShannons` rejects → the same silent row-drop class as the FX regression. Precision also degrades above 2^53 shannons. Replace with `toCkbInputValue(line.crypto.value)` — already imported in that file. Add a test covering a sub-100-shannon line.
- [ ] **C4.** Run all gates. Commit.

### Task D — Extract `useAutoBroadcast`

**Files:** create `src/features/payments/hooks/useAutoBroadcast.ts`; modify `PayPanel.tsx`

The ~45-line inline `onElapsed` arrow is the last real bulk in PayPanel and the reason it sits at 688 lines rather than under 500.

- [ ] **D1.** Extract the `onElapsed` handler into `useAutoBroadcast`. **`assertMultisigBytesMatchTreasury` must remain inside the shared `buildSignedTxAndBroadcast`, reached by both the manual and auto paths** — there are tests asserting the guard fires before broadcast on the auto path specifically, precisely to catch it being moved somewhere only one path reaches.
- [ ] **D2.** All existing tests must pass **unchanged**. If one needs editing, the extraction changed behaviour: stop and report.
- [ ] **D3.** Report `wc -l` for PayPanel. Under 500 is the target; if the extraction alone does not reach it, say so rather than moving more logic to hit a number.
- [ ] **D4.** Run all gates. Commit.

### Task E — Two dependency bumps

- [ ] **E1.** `undici` — HIGH: *TLS certificate validation bypass via dropped requestTls in SOCKS5 ProxyAgent*, plus *HTTP header injection via Set-Cookie percent-decoding*. It is a **runtime** dependency used for main-process HTTP (ERPNext, Esplora, Solana RPC). A non-major fix is available.
- [ ] **E2.** `react-router-dom` — moderate, non-major fix available.
- [ ] **E3.** Install exact-pinned with `--ignore-scripts`, and apply the same **14-day cooldown** used for the eslint setup: during an active npm supply-chain wave the newest publish is the higher-risk one. Check publish dates and prefer the newest release that is at least 14 days old and still resolves the advisory. If the only fix is a same-day publish, report it rather than taking it.
- [ ] **E4.** Confirm `npm audit` no longer lists those two, and that no NEW advisory appears in their trees.
- [ ] **E5.** Run all gates. Commit.

**Explicitly out of scope:** the Electron 33 → 43 upgrade. Ten majors with real breaking changes, and two of its CVEs (context-isolation bypass, contextBridge prototype setters) bear directly on the keystore signer's security model — it deserves its own plan and its own risk assessment, before release.
