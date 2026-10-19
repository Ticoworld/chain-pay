import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  bytesFrom,
  hexFrom,
  Script,
  Transaction,
} from "@ckb-ccc/core";
import { isMultisigTreasury, type CkbMultisig } from "@chain-pay/shared";
import { useTreasuryStore } from "@/stores/treasury";
import { useSyncStore } from "@/stores/sync";
import { lightClient } from "@/lib/light-client/client";
import { treasuryLockScript } from "@/lib/chains/ckb/address";
import { type CkbMultisigConfig } from "@/lib/chains/ckb/multisig";
import {
  assertMultisigBytesMatchTreasury,
  dumpInputsForInspection,
} from "@/lib/chains/ckb/multisig-assert";
import { ckbToShannons, toCkbInputValue } from "@/lib/chains/ckb/units";
import { lockFromAddress } from "@/lib/chains/ckb/address-lock";
import {
  buildPaymentSkeleton,
  type PaymentSkeleton,
} from "@/lib/chains/ckb/tx-builder";
import {
  encodeTransferPacket,
  treasurySighashDigest,
} from "@/lib/chains/ckb/transfer-packet";
import {
  mergeSignatures,
  type PartialSignature,
} from "@/lib/chains/ckb/merge-signatures";
import { AutoBroadcastCountdown } from "./AutoBroadcastCountdown";
import type { FxQuote, PartialSigEntry, PayeeProfile, PayrollBatch } from "@chain-pay/shared";
import {
  autoLabel,
  buildBatchLinesFromRecipients,
  monthEnd,
  monthStart,
  type RecipientRow,
  type SignatureRow,
} from "./payment-draft";
import { usePayeesStore } from "@/stores/payees";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { useIncomingSigsStore } from "@/stores/incoming-sigs";
import type { TransferPacket } from "@chain-pay/shared";
import type { OutgoingPacket } from "@/lib/comm/types";
import { CommSendSection } from "./CommSendSection";
import {
  fetchCkbPrices,
  fiatToCkbShannons,
} from "@/lib/fx/coingecko";
import { Section } from "@/components/ui/Section";
import { inputCls } from "./styles";
import { DraftForm } from "./DraftForm";
import { PacketPanel } from "./PacketPanel";
import { SignaturePanel } from "./SignaturePanel";
import { BroadcastResult } from "./BroadcastResult";
import { useAutoBroadcast } from "./hooks/useAutoBroadcast";
import { useFxSnapshot } from "./hooks/useFxSnapshot";
import { usePaymentDraft } from "./hooks/usePaymentDraft";
import { usePaymentLifecycle } from "./hooks/usePaymentLifecycle";

export function PayPanel() {
  const treasuries = useTreasuryStore((s) => s.treasuries);
  const ckbSync = useSyncStore((s) => s.ckb);
  const payeeStore = usePayeesStore();
  const batchStore = usePayrollBatchesStore();

  const ckbTreasuries = treasuries.filter(isMultisigTreasury).filter((t) => t.multisig.chain.startsWith("ckb:"));

  const draft = usePaymentDraft(ckbTreasuries[0]?.id ?? "");
  const lifecycle = usePaymentLifecycle();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // FX snapshot, lifted from DraftForm so handleBuild can persist it on the
  // PayrollBatch record. fxSnapshot maps CURRENCY → FxQuote (CKB-based).
  // Named `fxState` rather than `fx` because both loadPayees and refetchFx
  // already bind a local `fx` to the freshly fetched quote map.
  const fxState = useFxSnapshot();

  // Pre-select a batch and hydrate recipient rows from its lines if the
  // navigator passed `autoSelectBatchId` via state. Used by ReviewInvoiceForm
  // to land the operator on the batch they just queued. Only fires on mount.
  // Invoice-built batches have fiat amounts populated but crypto.value=0 — the
  // operator runs Fetch FX next to fill the amountCkb column.
  const location = useLocation();
  useEffect(() => {
    const state = location.state as { autoSelectBatchId?: string } | null;
    const batchId = state?.autoSelectBatchId;
    if (!batchId) return;
    lifecycle.setActiveBatchId(batchId);
    const batch = usePayrollBatchesStore.getState().findById(batchId);
    if (!batch || batch.kind !== "payroll" || batch.lines.length === 0) return;
    if (batch.treasuryId) draft.setTreasuryId(batch.treasuryId);
    const payees = usePayeesStore.getState().payees;
    const hydrated: RecipientRow[] = batch.lines.map((line) => {
      const payee = payees.find((p) => p.id === line.payeeId);
      const row: RecipientRow = {
        address: payee?.walletAddress ?? "",
        amountCkb: line.crypto.value > 0n ? toCkbInputValue(line.crypto.value) : "",
        payeeId: line.payeeId,
      };
      if (line.fxRate && line.fxRate !== "0") row.fxRate = line.fxRate;
      return row;
    });
    if (hydrated.length > 0) {
      draft.setRecipients(hydrated);
      // Kick off FX fetch with the fresh rows so the operator doesn't have to
      // hunt for a "Fetch FX" button — by default that button only appears
      // after quotes load. Fires-and-forgets; refetchFx surfaces its own errors.
      void refetchFx(hydrated);
    }
    // mount-only — don't react to location changes mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const treasury = ckbTreasuries.find((t) => t.id === draft.treasuryId);
  const multisig = treasury?.multisig as CkbMultisig | undefined;

  // 2.7b-2 drain-on-mount: if signatures arrived via comm while this PayPanel
  // wasn't observable, they're buffered in incoming-sigs. Drain into the
  // active batch when its sighashDigest becomes known.
  const activeBatch = lifecycle.activeBatchId
    ? batchStore.batches.find((b) => b.id === lifecycle.activeBatchId)
    : null;
  useEffect(() => {
    if (!activeBatch?.sighashDigest || !multisig) return;
    const buffered = useIncomingSigsStore.getState().peek(activeBatch.sighashDigest);
    if (buffered.length === 0) return;
    const { merged } = batchStore.drainIncomingSigsInto(activeBatch.id, {
      m: multisig.m,
      pubkeyHashes: multisig.pubkeyHashes,
    });
    if (merged === 0) return;
    // Reflect what the drain just merged into the batch's partialSigs back
    // into the `sigs` React state SignaturePanel renders and the M-of-N gate
    // reads. drainIncomingSigsInto already refuses to overwrite a slot
    // already present in partialSigs (`existingSlots`), so this can never
    // clobber an operator-typed signature — it only fills in what the drain
    // just accepted. Read fresh from the store rather than off `activeBatch`,
    // since the drain call above just mutated it. Uses lifecycle.setSigs
    // directly, NOT updateSigs: updateSigs writes straight back into the
    // store's partialSigs on every call, and looping that write through the
    // very state this effect reacts to risks a feedback loop.
    const updated = usePayrollBatchesStore.getState().findById(activeBatch.id);
    const partials = updated?.partialSigs ?? [];
    // `prev.map` only fills rows that already exist in `sigs` — it cannot
    // create a row for a slot `sigs` doesn't have yet. That's safe only
    // because a merge can never land while `sigs` is empty for a batch that
    // has this effect live: handleBuild seeds all `cfg.m` rows into `sigs`
    // in the same commit that sets `activeBatchId` (and the resume effect
    // does the same via `restoredSigs`), so by the time `activeBatch` is
    // non-null here, `sigs` already has one row per slot. If a future path
    // ever sets `activeBatchId` without seeding `sigs` first, a merge landing
    // in that window would be silently dropped with no later re-sync.
    lifecycle.setSigs((prev) =>
      prev.map((row) => {
        const found = partials.find((p) => p.slotIndex === row.slotIndex);
        return found ? { ...row, signature: found.signature } : row;
      }),
    );
    // `lifecycle` is a freshly-allocated object every render (same reasoning
    // as the resume effect below), so it deliberately stays out of the
    // dependency array — including it would re-run this effect on every
    // render. Safe without it: the drain itself is idempotent (the
    // `buffered.length === 0` guard above short-circuits once the buffer is
    // empty) and lifecycle.setSigs never changes activeBatch, multisig or
    // batchStore, so it cannot re-trigger this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBatch?.id, activeBatch?.sighashDigest, multisig, batchStore]);
  const cfg = useMemo<CkbMultisigConfig | null>(() => {
    if (!multisig) return null;
    return {
      s: 0,
      r: 0,
      m: multisig.m,
      n: multisig.n,
      pubkeyHashes: multisig.pubkeyHashes,
      ...(multisig.since !== undefined ? { since: multisig.since } : {}),
    };
  }, [multisig]);

  // Hydrate from a persisted draft when the user clicks "Resume" on a
  // PayrollBatches card. Resume sets `selectedDraftId` in the store; we
  // read it once, switch to the right treasury if needed, then rebuild the
  // ephemeral PayPanel state (skeleton, packet, sigs) without recomputing
  // anything that could drift (FX, capacities, digest).
  useEffect(() => {
    const draftId = batchStore.selectedDraftId;
    if (!draftId) return;
    const batch = batchStore.findById(draftId);
    if (!batch || !batch.txBytes || !batch.sighashDigest || !batch.totals) {
      batchStore.selectDraft(null);
      return;
    }
    if (batch.treasuryId !== draft.treasuryId) {
      // Switch treasuries first; the next render will materialize `cfg` and
      // re-enter this effect to actually hydrate.
      draft.setTreasuryId(batch.treasuryId);
      return;
    }
    if (!cfg || !multisig) return;
    try {
      const tx = Transaction.fromBytes(bytesFrom(batch.txBytes));
      const restored: PaymentSkeleton = {
        tx,
        totalIn: batch.totals.totalIn,
        totalOut: batch.totals.totalOut,
        fee: batch.totals.fee,
        change: batch.totals.change,
      };
      const json = encodeTransferPacket({
        skeleton: restored,
        treasuryConfig: cfg,
        network: multisig.chain === "ckb:mainnet" ? "mainnet" : "testnet",
        ...(batch.label ? { label: batch.label } : {}),
      });
      const restoredSigs: SignatureRow[] = Array.from(
        { length: cfg.m },
        (_, i) => {
          const found = batch.partialSigs?.find((p) => p.slotIndex === i);
          return { slotIndex: i, signature: found?.signature ?? "" };
        },
      );
      lifecycle.setSkeleton(restored);
      lifecycle.setPacketJson(json);
      lifecycle.setSigs(restoredSigs);
      draft.setLabel(batch.label);
      lifecycle.setActiveBatchId(batch.id);
      lifecycle.setPhase("packet-ready");
      setError(null);
    } catch (e) {
      setError(`Failed to resume draft: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      batchStore.selectDraft(null);
    }
    // `draft.treasuryId` (not `draft`) stays the dependency: the hook returns a
    // fresh object every render, so depending on it would re-run this effect on
    // every render instead of only on a treasury switch. Same reasoning applies
    // to `lifecycle`, which is likewise a freshly-allocated object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchStore, draft.treasuryId, cfg, multisig]);

  // Persist sig collection incrementally so closing the window mid-collection
  // doesn't lose work. Wrapped setter — same shape as setSigs for callers,
  // but writes through to the active batch's partialSigs on every change.
  const updateSigs = (next: SignatureRow[]) => {
    lifecycle.setSigs(next);
    if (lifecycle.activeBatchId) {
      const partials: PartialSigEntry[] = next
        .filter((s) => s.signature.trim().length > 0)
        .map((s) => ({ slotIndex: s.slotIndex, signature: s.signature.trim() }));
      batchStore.updateBatch(lifecycle.activeBatchId, { partialSigs: partials });
    }
  };

  const handleBuild = async () => {
    if (!cfg || !multisig) return;
    setError(null);
    setBusy(true);
    try {
      const treasuryScript = Script.from(treasuryLockScript(cfg));
      const parsedRecipients = draft.recipients.map((r, i) => {
        const lock = lockFromAddress(r.address.trim());
        const capacity = ckbToShannons(r.amountCkb);
        if (capacity === null) throw new Error(`Recipient ${i + 1}: amount must be a positive number`);
        return { lock, capacity };
      });
      const cells = await lightClient().listCellsForLock(treasuryScript);
      if (cells.length === 0) {
        throw new Error(
          "no cells found for this treasury — fund the address first, then wait for sync",
        );
      }
      const result = buildPaymentSkeleton({
        treasuryConfig: cfg,
        treasuryScript,
        recipients: parsedRecipients,
        availableCells: cells,
        network: multisig.chain === "ckb:mainnet" ? "mainnet" : "testnet",
        feeRateShannonsPerByte: BigInt(draft.feeRate),
      });
      const json = encodeTransferPacket({
        skeleton: result,
        treasuryConfig: cfg,
        network: multisig.chain === "ckb:mainnet" ? "mainnet" : "testnet",
        ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
      });
      lifecycle.setSkeleton(result);
      lifecycle.setPacketJson(json);
      lifecycle.setSigs(
        Array.from({ length: cfg.m }, (_, i) => ({ slotIndex: i, signature: "" })),
      );
      lifecycle.setPhase("packet-ready");

      // If the draft was sourced from payees, snapshot it as a PayrollBatch
      // in the 'calculated' state. Manual one-off payments (no payeeId on any
      // row) skip batch creation — they're not payroll, they're treasury
      // spends. The persisted snapshot carries the serialized tx + sighash
      // digest so PayPanel can resume from step 5/6 across navigation and
      // window reloads — critical because FX-rate drift on re-fetch would
      // otherwise change capacities → invalidate sigs already collected.
      const payeeLines = buildBatchLinesFromRecipients(
        draft.recipients,
        payeeStore.findById,
      );
      if (payeeLines.length > 0) {
        const id = (globalThis.crypto?.randomUUID?.() ?? `b-${Date.now()}`) as string;
        const now = new Date().toISOString();
        const digest = treasurySighashDigest(result.tx);
        const batch: PayrollBatch = {
          id,
          kind: "payroll",
          label: draft.label.trim() || autoLabel(),
          treasuryId: draft.treasuryId,
          cycleStart: monthStart(),
          cycleEnd: monthEnd(),
          fxSnapshot: Array.from(fxState.fxSnapshot.values()),
          lines: payeeLines,
          state: "calculated",
          createdAt: now,
          updatedAt: now,
          txBytes: hexFrom(result.tx.toBytes()),
          sighashDigest: digest,
          totals: {
            totalIn: result.totalIn,
            totalOut: result.totalOut,
            fee: result.fee,
            change: result.change,
          },
          commPacket: json,
          partialSigs: [],
        };
        batchStore.addBatch(batch);
        lifecycle.setActiveBatchId(id);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Core merge-and-broadcast sequence shared by the manual button and the
   * auto-broadcast countdown.  Reconstructs the tx from `txBytes` (or falls
   * back to `skeleton.tx` when called from the manual path), merges the
   * provided partial signatures, runs pre-broadcast sanity checks, then
   * broadcasts through the light client.
   *
   * @param tx        - The unsigned transaction to sign and broadcast.
   * @param partials  - The M partial signatures to merge.
   * @returns The confirmed tx hash.
   */
  async function buildSignedTxAndBroadcast(
    tx: Transaction,
    partials: PartialSignature[],
  ): Promise<string> {
    if (!cfg) throw new Error("No multisig config available");

    const digest = treasurySighashDigest(tx);
    mergeSignatures(tx, cfg, digest, partials);

    // Pre-broadcast sanity: the multisig_script now sitting in witness[0]
    // MUST blake160 to the input cells' lock.args, or the chain returns -52
    // (ERROR_MULTSIG_SCRIPT_HASH). We check three things, in order of
    // diagnostic value:
    //
    //   1. cfg ↔ treasury.address: the stored treasury address must
    //      decode to lock.args matching what cfg.pubkeyHashes encode.
    //      If this fails, the wizard/persist layer mutated cfg without
    //      keeping address in sync.
    //   2. witness[0] ↔ cfg: the bytes mergeSignatures just wrote must
    //      blake160 to the same lock.args. If this fails, mergeSignatures
    //      or WitnessArgs round-trip is corrupting bytes.
    //   3. tx.inputs[0] ↔ treasury: caller's responsibility — the cells
    //      we're spending must be at the treasury's lock. Not checked
    //      inline (would need a chain query) but logged for inspection.
    if (multisig) {
      assertMultisigBytesMatchTreasury(tx, cfg, multisig);
      dumpInputsForInspection(tx, multisig);
    }

    return lightClient().broadcastTransaction(tx);
  }

  // The auto-broadcast countdown's elapsed handler. `buildSignedTxAndBroadcast`
  // is handed in rather than reimplemented so the auto path runs the *same*
  // pre-broadcast multisig guard as the manual button above.
  const onAutoBroadcastElapsed = useAutoBroadcast({
    batch: activeBatch,
    batchStore,
    broadcast: buildSignedTxAndBroadcast,
    onBroadcasted: (txHash) => {
      lifecycle.setBroadcastedTxHash(txHash);
      lifecycle.setPhase("broadcasted");
    },
  });

  const handleBroadcast = async () => {
    if (!cfg || !lifecycle.skeleton) return;
    setError(null);
    setBusy(true);
    try {
      const partials: PartialSignature[] = lifecycle.sigs.map((s) => {
        if (!s.signature.trim()) throw new Error("All signature slots must be filled");
        return { slotIndex: s.slotIndex, signature: s.signature.trim() };
      });

      // Mark the batch approved just before send so a network failure leaves
      // us in a recoverable state (approved → calculated is a legal revert).
      if (lifecycle.activeBatchId) {
        try {
          batchStore.transition(lifecycle.activeBatchId, "approved");
        } catch {
          // ignore — batch may have been manually advanced or deleted
        }
      }
      const txHash = await buildSignedTxAndBroadcast(lifecycle.skeleton.tx, partials);
      lifecycle.setBroadcastedTxHash(txHash);
      lifecycle.setPhase("broadcasted");
      if (lifecycle.activeBatchId) {
        try {
          batchStore.transition(lifecycle.activeBatchId, "broadcasted");
          batchStore.updateBatch(lifecycle.activeBatchId, {
            pendingTxId: txHash,
            // Sigs are now embedded in the broadcast tx — no reason to keep
            // them around in the persisted batch.
            partialSigs: [],
          });
        } catch {
          // ignore — same recovery as above
        }
      }
    } catch (e: unknown) {
      const base = e instanceof Error ? e.message : String(e);
      // Append input outpoints to broadcast errors so the user can paste them
      // straight into an explorer without digging in DevTools — diagnoses -52
      // (input at wrong lock) and -51 (sig vs lock mismatch) by inspection.
      const inputs = lifecycle.skeleton?.tx.inputs ?? [];
      const inputSummary = inputs
        .map((inp, i) => `  [${i}] ${hexFrom(inp.previousOutput.txHash)} #${inp.previousOutput.index}`)
        .join("\n");
      const debug = inputs.length > 0 ? `\n\nTx inputs:\n${inputSummary}` : "";
      setError(`${base}${debug}`);
    } finally {
      setBusy(false);
    }
  };

  // Clears exactly what the pre-hook inline handler cleared: the tx lifecycle
  // (via lifecycle.reset), the error banner and the FX snapshot. `error` and the
  // FX state live outside usePaymentLifecycle, so they are cleared here. All
  // nine are independent useState setters batched into one render, so the
  // reordering of setError relative to setActiveBatchId is not observable.
  // recipients / feeRate / label are deliberately NOT cleared — BUG PIN.
  const reset = () => {
    lifecycle.reset();
    setError(null);
    fxState.setFxSnapshot(new Map());
    fxState.setFxError(null);
  };

  function fillAmountsFromFx(
    rows: RecipientRow[],
    fx: Map<string, FxQuote>,
  ): RecipientRow[] {
    return rows.map((row) => {
      if (!row.payeeId) return row;
      const payee = payeeStore.findById(row.payeeId);
      if (!payee) return row;
      const quote = fx.get(payee.salaryFiat.currency.toUpperCase());
      if (!quote) return row;
      try {
        const shannons = fiatToCkbShannons(payee.salaryFiat, quote);
        // Stored into amountCkb, a form field re-parsed by ckbToShannons —
        // must stay unformatted (no thousands separators). See units.ts.
        const ckb = toCkbInputValue(shannons);
        return { ...row, amountCkb: ckb, fxRate: quote.rate };
      } catch {
        return row;
      }
    });
  }

  async function loadPayees(payees: PayeeProfile[]) {
    const existing = draft.recipients.filter((r) => r.address.trim() || r.amountCkb.trim());
    const additions = payees.map((p) => ({
      address: p.walletAddress,
      amountCkb: "",
      payeeId: p.id,
    }));
    let next = [...existing, ...additions];
    if (next.length === 0) next = [{ address: "", amountCkb: "" }];
    draft.setRecipients(next);

    const currencies = Array.from(
      new Set(payees.map((p) => p.salaryFiat.currency.toUpperCase())),
    );
    if (currencies.length === 0) return;

    fxState.setFxLoading(true);
    fxState.setFxError(null);
    try {
      const fx = await fetchCkbPrices(currencies);
      const merged = new Map(fxState.fxSnapshot);
      for (const [k, v] of fx) merged.set(k, v);
      fxState.setFxSnapshot(merged);
      draft.setRecipients(fillAmountsFromFx(next, merged));
    } catch (e) {
      fxState.setFxError(e instanceof Error ? e.message : String(e));
    } finally {
      fxState.setFxLoading(false);
    }
  }

  async function refetchFx(rowsOverride?: RecipientRow[]): Promise<void> {
    // Allow callers (e.g. mount-time hydration) to pass a fresh rows array so
    // currency detection isn't gated on the React state update having flushed.
    const rows = rowsOverride ?? draft.recipients;
    const currencies = Array.from(
      new Set(
        rows
          .map((r) => (r.payeeId ? payeeStore.findById(r.payeeId)?.salaryFiat.currency : null))
          .filter((c): c is string => Boolean(c))
          .map((c) => c.toUpperCase()),
      ),
    );
    if (currencies.length === 0) return;
    fxState.setFxLoading(true);
    fxState.setFxError(null);
    try {
      const fx = await fetchCkbPrices(currencies);
      fxState.setFxSnapshot(fx);
      draft.setRecipients(fillAmountsFromFx(rows, fx));
    } catch (e) {
      fxState.setFxError(e instanceof Error ? e.message : String(e));
    } finally {
      fxState.setFxLoading(false);
    }
  }

  if (ckbTreasuries.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Send payment</h1>
        <div className="rounded-lg border border-surface-hi bg-surface p-6 text-sm text-fg-muted">
          No CKB treasuries yet.{" "}
          <Link to="/treasury/new" className="text-accent hover:underline">
            Create a multisig
          </Link>{" "}
          to get started.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Send payment</h1>
        <p className="text-sm text-fg-muted">
          Build a payment from a multisig treasury, hand the packet to co-signers, paste their
          signatures back, then broadcast through the embedded light client.
        </p>
      </header>

      <Section title="1. Treasury">
        <select
          value={draft.treasuryId}
          onChange={(e) => {
            draft.setTreasuryId(e.target.value);
            reset();
          }}
          className={inputCls}
        >
          {ckbTreasuries.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label} ({(t.multisig as CkbMultisig).m}-of-{(t.multisig as CkbMultisig).n})
            </option>
          ))}
        </select>
        {multisig ? (
          <div className="mt-2 break-all font-mono text-xs text-fg-muted">{multisig.address}</div>
        ) : null}
      </Section>

      {lifecycle.phase === "draft" && multisig ? (
        <DraftForm
          treasuryChain={multisig.chain}
          recipients={draft.recipients}
          setRecipients={draft.setRecipients}
          feeRate={draft.feeRate}
          setFeeRate={draft.setFeeRate}
          label={draft.label}
          setLabel={draft.setLabel}
          onBuild={handleBuild}
          busy={busy}
          syncReady={ckbSync.started && ckbSync.peers > 0}
          loadPayees={loadPayees}
          refetchFx={refetchFx}
          fxQuotes={Array.from(fxState.fxSnapshot.values())}
          fxLoading={fxState.fxLoading}
          fxError={fxState.fxError}
        />
      ) : null}

      {lifecycle.phase !== "draft" && lifecycle.skeleton && cfg ? (
        <PacketPanel
          packetJson={lifecycle.packetJson}
          skeleton={lifecycle.skeleton}
        />
      ) : null}

      {(lifecycle.phase === "packet-ready" || lifecycle.phase === "broadcast-ready") &&
      activeBatch?.state !== "broadcast_countdown" &&
      activeBatch?.state !== "broadcast_initiating" &&
      cfg && multisig ? (
        <SignaturePanel
          cfg={cfg}
          sigs={lifecycle.sigs}
          setSigs={updateSigs}
          onBroadcast={handleBroadcast}
          busy={busy}
        />
      ) : null}

      {(lifecycle.phase === "packet-ready" || lifecycle.phase === "broadcast-ready") &&
      lifecycle.activeBatchId &&
      activeBatch?.sighashDigest &&
      multisig &&
      lifecycle.packetJson ? (
        <CommSendSection
          batchId={lifecycle.activeBatchId}
          packet={
            {
              txHash: activeBatch.sighashDigest,
              treasuryAddress: multisig.address,
              // Spec: 24 h advisory expiry; receiver enforcement is 2.7b-3.
              expiresAt: Math.floor(Date.now() / 1000) + 86_400,
              packet: lifecycle.packetJson as TransferPacket,
            } satisfies OutgoingPacket
          }
          multisig={{ pubkeyHashes: multisig.pubkeyHashes }}
        />
      ) : null}

      {/* Auto-broadcast toggle — visible when batch is approved (sigs being collected). */}
      {activeBatch && activeBatch.state === "approved" ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={activeBatch.autoBroadcast === true}
            onChange={(e) => batchStore.setAutoBroadcast(activeBatch.id, e.target.checked)}
          />
          <span>Auto-broadcast when M sigs collected</span>
        </label>
      ) : null}

      {/* Auto-broadcast countdown — fires when store transitions to broadcast_countdown. */}
      {activeBatch && activeBatch.state === "broadcast_countdown" ? (
        <AutoBroadcastCountdown
          onElapsed={onAutoBroadcastElapsed}
          onCancel={() => batchStore.cancelAutoBroadcast(activeBatch.id)}
        />
      ) : null}

      {/* Retry button — visible when auto-broadcast failed. */}
      {activeBatch && activeBatch.state === "broadcast_failed" ? (
        <div className="rounded border border-red-800 bg-red-950/40 p-3 text-sm">
          <strong className="block">Broadcast failed</strong>
          <p className="text-xs text-neutral-400 mb-2">{activeBatch.broadcastError}</p>
          <button
            type="button"
            onClick={() => batchStore.retryAutoBroadcast(activeBatch.id)}
            className="px-3 py-1 rounded bg-amber-600 hover:bg-amber-500 text-sm"
          >
            Retry broadcast
          </button>
        </div>
      ) : null}

      {lifecycle.phase === "broadcasted" && lifecycle.broadcastedTxHash ? (
        <BroadcastResult txHash={lifecycle.broadcastedTxHash} network={multisig?.chain ?? ""} onReset={reset} />
      ) : null}

      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
          {error}
        </div>
      ) : null}
    </div>
  );
}
