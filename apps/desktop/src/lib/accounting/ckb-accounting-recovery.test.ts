import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConfirmedPaymentRecord,
  PayrollBatch,
  SendRecord,
  VendorPaymentBatch,
} from "@chain-pay/shared";
import { MemoryStorage } from "@/stores/test-utils/memory-storage";

const { postJournal } = vi.hoisted(() => ({ postJournal: vi.fn() }));
vi.mock("@/lib/accounting/ipc", () => ({ postJournal }));

const CONFIRMED_AT = "2026-10-17T10:00:00.000Z";
const FAILED_AT = "2026-10-17T10:00:20.000Z";
const RETRIED_AT = "2026-10-18T11:00:00.000Z";
const TX_HASH = `0x${"ab".repeat(32)}` as const;
const result = {
  jeName: "ACC-JV-EXISTING",
  recordName: "CPB-EXISTING",
  idempotent: true,
  recordIdempotent: true,
};
const fiat = { currency: "USD", minor: 100n };
const amount = { asset: "CKB", value: 7_000_000_000n, decimals: 8 };

function payrollBatch(state: "confirmed" | "broadcasted"): PayrollBatch {
  return {
    id: "payroll",
    kind: "payroll",
    label: "Payroll",
    treasuryId: "treasury",
    cycleStart: "2026-10-01",
    cycleEnd: "2026-10-31",
    lines: [{
      payeeId: "payee",
      fiat,
      crypto: amount,
      fxRate: "1",
      feeAllocated: { ...amount, value: 0n },
    }],
    fxSnapshot: [],
    state,
    pendingTxId: TX_HASH,
    createdAt: CONFIRMED_AT,
    updatedAt: CONFIRMED_AT,
  };
}

function sendRecord(state: "confirmed" | "broadcasted"): SendRecord {
  return {
    id: "send",
    sourceId: "source",
    chain: "ckb:testnet",
    state,
    txHash: `0x${"cd".repeat(32)}`,
    outputs: [{ payeeId: "payee", payeeAddress: "ckt1fixture", fiat, amount }],
    feeShannons: 1000n,
    createdAt: CONFIRMED_AT,
    updatedAt: CONFIRMED_AT,
  };
}

async function loadWorkflow(kind: "payroll" | "send") {
  if (kind === "payroll") {
    const { usePayrollBatchesStore } = await import("@/stores/payroll-batches");
    const { postBatchJournal } = await import("./post-batch-journal");
    return {
      seed(state: "confirmed" | "broadcasted" = "confirmed") {
        usePayrollBatchesStore.setState({ batches: [payrollBatch(state)] });
      },
      read: () => usePayrollBatchesStore.getState().findById(kind)!,
      confirm: () => usePayrollBatchesStore.getState().transition(kind, "confirmed"),
      post: () => postBatchJournal(kind),
    };
  }
  const { useSendsStore } = await import("@/stores/sends");
  const { postSendJournal } = await import("@/lib/send/send-journal");
  return {
    seed(state: "confirmed" | "broadcasted" = "confirmed") {
      useSendsStore.setState({ sends: [sendRecord(state)] });
    },
    read: () => useSendsStore.getState().sends.find((send) => send.id === kind)!,
    confirm: () => useSendsStore.getState().markConfirmed(kind),
    post: () => postSendJournal(kind),
  };
}

function serialise(record: ConfirmedPaymentRecord): string {
  return JSON.stringify(record, (_key, value) => typeof value === "bigint" ? value.toString() : value);
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(CONFIRMED_AT);
  globalThis.localStorage = new MemoryStorage();
  postJournal.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe.each(["payroll", "send"] as const)("%s accounting recovery", (kind) => {
  it("replays the same immutable source after Frappe commits but its response is lost", async () => {
    const workflow = await loadWorkflow(kind);
    workflow.seed();
    let committedRecord: string | undefined;
    postJournal.mockImplementation(async (record: ConfirmedPaymentRecord) => {
      if (!committedRecord) {
        committedRecord = serialise(record);
        vi.setSystemTime(FAILED_AT);
        throw new Error("Response lost after server commit");
      }
      if (serialise(record) !== committedRecord) throw new Error("different immutable data");
      return result;
    });

    await workflow.post();
    expect(workflow.read()).toMatchObject({ state: "post_failed", updatedAt: FAILED_AT });
    vi.setSystemTime(RETRIED_AT);
    await workflow.post();

    expect(postJournal).toHaveBeenCalledTimes(2);
    expect(postJournal.mock.calls[1]![0]).toEqual(postJournal.mock.calls[0]![0]);
    expect(workflow.read()).toMatchObject({ state: "posted", updatedAt: RETRIED_AT });
  });

  it("recovers a persisted in-flight post and reuses its source after a restart", async () => {
    let workflow = await loadWorkflow(kind);
    workflow.seed();
    postJournal.mockImplementationOnce(() => new Promise<never>(() => undefined));
    void workflow.post();
    expect(workflow.read().state).toBe("posting");
    const committedRecord = postJournal.mock.calls[0]![0];

    vi.resetModules();
    vi.setSystemTime(RETRIED_AT);
    workflow = await loadWorkflow(kind);
    expect(workflow.read().state).toBe("post_failed");
    expect(postJournal).toHaveBeenCalledTimes(1);
    postJournal.mockImplementation(async (record: ConfirmedPaymentRecord) => {
      if (serialise(record) !== serialise(committedRecord)) throw new Error("different immutable data");
      return result;
    });
    await workflow.post();

    expect(postJournal).toHaveBeenCalledTimes(2);
    expect(postJournal.mock.calls[1]![0]).toEqual(committedRecord);
    expect(workflow.read().state).toBe("posted");
  });

  it("records confirmation time independently of later lifecycle updates", async () => {
    const workflow = await loadWorkflow(kind);
    workflow.seed("broadcasted");
    workflow.confirm();
    expect(workflow.read()).toMatchObject({ confirmedAt: CONFIRMED_AT });
    vi.setSystemTime(RETRIED_AT);
    postJournal.mockResolvedValue(result);
    await workflow.post();
    expect(postJournal.mock.calls[0]![0]).toMatchObject({ confirmedAt: CONFIRMED_AT });
    expect(workflow.read()).toMatchObject({ confirmedAt: CONFIRMED_AT, updatedAt: RETRIED_AT });
  });
});

it("allows correcting a missing send valuation before its first server request", async () => {
  const workflow = await loadWorkflow("send");
  workflow.seed();
  const { useSendsStore } = await import("@/stores/sends");
  useSendsStore.setState({
    sends: useSendsStore.getState().sends.map((send) => ({
      ...send,
      outputs: send.outputs.map((output) => ({ ...output, fiat: { ...output.fiat, minor: 0n } })),
    })),
  });
  await workflow.post();
  expect(postJournal).not.toHaveBeenCalled();
  expect(workflow.read().state).toBe("post_failed");
  vi.setSystemTime(RETRIED_AT);
  useSendsStore.getState().updateAccountingValues("send", [100n]);
  postJournal.mockResolvedValue(result);
  await workflow.post();
  expect(postJournal.mock.calls[0]![0]).toMatchObject({
    confirmedAt: CONFIRMED_AT,
    lines: [{ fiat: { minor: 100n } }],
  });
  expect(workflow.read().state).toBe("posted");
});

it("recovers only interrupted payroll posts during hydration", async () => {
  const { usePayrollBatchesStore } = await import("@/stores/payroll-batches");
  const batch = payrollBatch("confirmed");
  const vendor: VendorPaymentBatch = {
    ...batch, kind: "vendor", vendorId: "vendor", invoiceIds: ["invoice"], lines: [],
  };
  usePayrollBatchesStore.setState({ batches: [
    { ...batch, id: "interrupted", state: "posting" },
    { ...batch, id: "confirmed" },
    { ...batch, id: "failed", state: "post_failed", postError: "prior error" },
    { ...batch, id: "posted", state: "posted", jeName: result.jeName },
    { ...vendor, id: "vendor", state: "posting" },
  ] });

  vi.resetModules();
  vi.setSystemTime(RETRIED_AT);
  const restored = await import("@/stores/payroll-batches");
  const batches = restored.usePayrollBatchesStore.getState().batches;
  expect(batches.map(({ id, state }) => [id, state])).toEqual([
    ["interrupted", "post_failed"], ["confirmed", "confirmed"],
    ["failed", "post_failed"], ["posted", "posted"], ["vendor", "posting"],
  ]);
  expect(batches[0]).toMatchObject({ postError: expect.stringMatching(/interrupted/i) });
  expect(batches[2]).toMatchObject({ postError: "prior error", updatedAt: CONFIRMED_AT });
  expect(batches[3]).toMatchObject({ jeName: result.jeName, updatedAt: CONFIRMED_AT });
  expect(postJournal).not.toHaveBeenCalled();
});
