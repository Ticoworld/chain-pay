import { bytesFrom, Transaction } from "@ckb-ccc/core";
import type { AnyBatch, PayrollBatch, PayrollBatchState } from "@chain-pay/shared";
import type { PartialSignature } from "@/lib/chains/ckb/merge-signatures";
import { useNetworkConfigStore } from "@/stores/network-config";

/**
 * The slice of the payroll-batches store this hook drives. Declared
 * structurally (rather than importing the store's own interface, which is not
 * exported) so the dependency surface is visible at a glance: four writes, no
 * reads. The real store satisfies it.
 */
export interface AutoBroadcastBatchStore {
  markBroadcastInitiating: (batchId: string) => boolean;
  markBroadcastFailed: (batchId: string, error: string) => void;
  transition: (id: string, to: PayrollBatchState) => void;
  updateBatch: (
    id: string,
    patch: Partial<Omit<PayrollBatch, "id" | "createdAt" | "kind">>,
  ) => void;
}

export interface UseAutoBroadcastArgs {
  /** The batch the countdown is running for, or null/undefined when there is none. */
  batch: AnyBatch | null | undefined;
  batchStore: AutoBroadcastBatchStore;
  /**
   * The shared merge-sign-and-broadcast sequence. Supplied by the caller
   * rather than built here **on purpose**: `assertMultisigBytesMatchTreasury`
   * lives inside it, and the manual broadcast button must reach exactly the
   * same function. Pulling that guard into this hook would leave the manual
   * path unguarded (or duplicate it, which drifts). Tests assert the guard
   * fires before `broadcastTransaction` on the auto path specifically.
   */
  broadcast: (tx: Transaction, partials: PartialSignature[]) => Promise<string>;
  /** Called with the confirmed tx hash so the shell can advance its own phase. */
  onBroadcasted: (txHash: string) => void;
}

/**
 * The auto-broadcast countdown's `onElapsed` handler, lifted out of PayPanel's
 * JSX.
 *
 * Deliberately returns a **fresh function on every render**, exactly as the
 * inline arrow it replaces did. `AutoBroadcastCountdown` lists `onElapsed` in
 * its countdown effect's dependency array, so memoising it here would change
 * how often that effect re-subscribes its chained `setTimeout` — a timing
 * change, not a refactor. The component's own `firedRef` is what guarantees a
 * single fire, not this identity.
 */
export function useAutoBroadcast({
  batch,
  batchStore,
  broadcast,
  onBroadcasted,
}: UseAutoBroadcastArgs): () => Promise<void> {
  return async () => {
    // Unreachable from the rendered path — the countdown only mounts inside a
    // `batch && batch.state === "broadcast_countdown"` gate, so the closure
    // that gets called always captured a non-null batch. Present because the
    // hook is called unconditionally at the top of the component.
    if (!batch) return;

    // Guard: a broadcast RPC URL must be configured (or light-client
    // broadcast must be viable). Check before marking initiating so
    // the user sees a clear error instead of a silent failure. This
    // relies on state-machine.ts allowing broadcast_countdown →
    // broadcast_failed (see Task A of the auto-broadcast bug bundle);
    // before that, markBroadcastFailed silently no-op'd here and the
    // batch stayed wedged in broadcast_countdown forever.
    const { broadcastRpcUrl } = useNetworkConfigStore.getState();
    if (!broadcastRpcUrl) {
      batchStore.markBroadcastFailed(batch.id, "Configure broadcast RPC URL in Settings");
      return;
    }
    // Reconstruct the tx from the persisted bytes so this path is
    // independent of React state (skeleton may be null if the user
    // navigated away and back).
    if (!batch.txBytes) {
      batchStore.markBroadcastFailed(
        batch.id,
        "No transaction bytes in batch — this draft can't be resumed; start a new payment",
      );
      return;
    }
    if (!batch.partialSigs || batch.partialSigs.length === 0) {
      batchStore.markBroadcastFailed(
        batch.id,
        "No partial signatures collected yet — collect signatures, then retry the broadcast",
      );
      return;
    }
    if (!batchStore.markBroadcastInitiating(batch.id)) return;
    try {
      const tx = Transaction.fromBytes(bytesFrom(batch.txBytes));
      const partials: PartialSignature[] = batch.partialSigs.map((p) => ({
        slotIndex: p.slotIndex,
        signature: p.signature,
      }));
      // `broadcast` merges sigs into tx, runs the pre-broadcast sanity
      // checks, then broadcasts — same path as manual handleBroadcast.
      const txHash = await broadcast(tx, partials);
      onBroadcasted(txHash);
      batchStore.transition(batch.id, "broadcasted");
      batchStore.updateBatch(batch.id, { pendingTxId: txHash, partialSigs: [] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      batchStore.markBroadcastFailed(batch.id, msg);
    }
  };
}
