import { beforeEach, expect, it, vi } from "vitest";
import { hexFrom, Transaction } from "@ckb-ccc/core";
import type { AnyBatch } from "@chain-pay/shared";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { useNetworkConfigStore } from "@/stores/network-config";
import { useAutoBroadcast } from "./useAutoBroadcast";

beforeEach(() => {
  usePayrollBatchesStore.setState({ batches: [], selectedDraftId: null });
  useNetworkConfigStore.setState({ broadcastRpcUrl: "http://node:8114" });
});

it("submits a countdown batch only once when elapsed callbacks race", async () => {
  const tx = Transaction.from({
    inputs: [{ previousOutput: { txHash: `0x${"ab".repeat(32)}`, index: 0 } }],
    outputs: [],
    outputsData: [],
  });
  const batch = {
    id: "b1",
    state: "broadcast_countdown",
    txBytes: hexFrom(tx.toBytes()),
    partialSigs: [{ slotIndex: 0, signature: `0x${"cd".repeat(65)}` }],
  } as AnyBatch;
  usePayrollBatchesStore.getState().addBatch(batch);
  const broadcast = vi.fn(async () => `0x${"ef".repeat(32)}`);
  const onBroadcasted = vi.fn();
  const onElapsed = useAutoBroadcast({
    batch,
    batchStore: usePayrollBatchesStore.getState(),
    broadcast,
    onBroadcasted,
  });

  await Promise.all([onElapsed(), onElapsed()]);

  expect(broadcast).toHaveBeenCalledTimes(1);
  expect(onBroadcasted).toHaveBeenCalledTimes(1);
  expect(usePayrollBatchesStore.getState().findById("b1")?.state).toBe("broadcasted");
});
