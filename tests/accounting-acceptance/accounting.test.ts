import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createFaultProxy } from "./fault-proxy";
import type { TransactionHash } from "@chain-pay/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildConfirmedPayrollRecord } from "../../apps/desktop/src/lib/accounting/batch-to-journal-inputs";
import { buildConfirmedSendRecord } from "../../apps/desktop/src/lib/send/send-journal";
import { postJournalToFrappe, fetchComplianceExport } from "../../apps/desktop/electron/main/accounting-host";

vi.mock("electron", () => ({ dialog: {}, ipcMain: {} }));

const fixtureDate = (await readFile("/tmp/acceptance-date", "utf8")).trim();
const confirmedAt = fixtureDate + "T10:00:00.000Z";
const amount = { asset: "CKB", value: 7_000_000_000n, decimals: 8 };
const fiat = { currency: "USD", minor: 12345n };
const digest = (label: string) => ("0x" + createHash("sha256").update(label).digest("hex")) as TransactionHash;
const payroll = buildConfirmedPayrollRecord({
  id: "acceptance-payroll-v1", kind: "payroll", label: "Synthetic payroll rehearsal",
  treasuryId: "fixture-treasury", cycleStart: fixtureDate, cycleEnd: fixtureDate,
  state: "confirmed", pendingTxId: digest("acceptance-payroll-v1"),
  createdAt: confirmedAt, updatedAt: confirmedAt, fxSnapshot: [],
  lines: ["synthetic-alice", "synthetic-bob"].map((payeeId) => ({
    payeeId, fiat, crypto: amount, fxRate: "1", feeAllocated: { ...amount, value: 0n },
  })),
});
const send = buildConfirmedSendRecord({
  id: "acceptance-send-v1", sourceId: "fixture-source", chain: "ckb:testnet",
  state: "confirmed", txHash: digest("acceptance-send-v1"), feeShannons: 1000n,
  createdAt: confirmedAt, updatedAt: confirmedAt,
  outputs: [{ payeeId: "synthetic-charlie", payeeAddress: "ckt1fixture", fiat, amount }],
});
const lostReply = {
  ...send, batchId: "acceptance-lost-reply-v1", txHash: digest("acceptance-lost-reply-v1"),
  label: "Synthetic lost reply rehearsal",
};
const identities: Record<string, unknown> = {};
const proxy = createFaultProxy("backend", 8000, "accounting-acceptance.localhost:8000");
let accountingCredentials: { api_key: string; api_secret: string };
let unprivilegedCredentials: { api_key: string; api_secret: string };
function useCredentials(credentials: typeof accountingCredentials) {
  process.env.FRAPPE_API_KEY = credentials.api_key;
  process.env.FRAPPE_API_SECRET = credentials.api_secret;
}

beforeAll(async () => {
  accountingCredentials = JSON.parse(await readFile("/tmp/acceptance-accounting.json", "utf8"));
  unprivilegedCredentials = JSON.parse(await readFile("/tmp/acceptance-unprivileged.json", "utf8"));
  process.env.FRAPPE_URL = await proxy.listen();
  useCredentials(accountingCredentials);
});

afterAll(async () => {
  await proxy.close();
  await writeFile("/tmp/acceptance-summary.json", JSON.stringify({
    fixtureDate,
    identities, timings: proxy.timings, committedReply: proxy.droppedReply,
  }, null, 2));
  delete process.env.FRAPPE_URL;
  delete process.env.FRAPPE_API_KEY;
  delete process.env.FRAPPE_API_SECRET;
});

describe.sequential("desktop accounting acceptance rehearsal", () => {
  it("posts a real two-payee payroll and reuses its identities on exact replay", async () => {
    const first = await postJournalToFrappe(payroll);
    const retry = await postJournalToFrappe(payroll);
    expect(retry).toEqual({ ...first, idempotent: true, recordIdempotent: true });
    identities.payroll = retry;
  });

  it("posts a real send built by the production record builder", async () => {
    const first = await postJournalToFrappe(send);
    const retry = await postJournalToFrappe(send);
    expect(retry).toEqual({ ...first, idempotent: true, recordIdempotent: true });
    identities.send = retry;
  });

  it("recovers the same accepted source after the proxy drops a successful reply", async () => {
    proxy.dropResponseFor(lostReply.batchId);
    await expect(postJournalToFrappe(lostReply)).rejects.toThrow("Frappe accounting request failed");
    const committedReply = proxy.droppedReply;
    expect(committedReply).toMatchObject({ je_name: expect.any(String), record_name: expect.any(String) });
    const retry = await postJournalToFrappe(lostReply);
    expect(retry).toMatchObject({
      jeName: (committedReply as { je_name: string }).je_name,
      recordName: (committedReply as { record_name: string }).record_name,
      idempotent: true, recordIdempotent: true,
    });
    identities.lostReply = retry;
  });

  it("retains server-owned immutability across the actual HTTP boundary", async () => {
    await expect(postJournalToFrappe({ ...send, label: "Changed accepted identity" })).rejects.toThrow(/rejected the request/);
    expect(await postJournalToFrappe(send)).toEqual(identities.send);
  });

  it("enforces real HTTP authentication and Accounts roles", async () => {
    process.env.FRAPPE_API_SECRET = "invalid-acceptance-secret";
    await expect(postJournalToFrappe(send)).rejects.toThrow(/rejected the request \(401\)/);
    useCredentials(unprivilegedCredentials);
    try {
      await expect(postJournalToFrappe(send)).rejects.toThrow(/rejected the request \(403\)/);
      await expect(fetchComplianceExport({ chain: "ckb:testnet" }, "csv")).rejects.toThrow(/rejected the request \(403\)/);
    } finally {
      useCredentials(accountingCredentials);
    }
  });

  it("exports four exact source lines as integrity-checked CSV and printable PDF", async () => {
    const filters = { chain: "ckb:testnet" as const, fromDate: fixtureDate, toDate: fixtureDate };
    const csv = await fetchComplianceExport(filters, "csv");
    const pdf = await fetchComplianceExport(filters, "pdf");
    expect(csv.rowCount).toBe(4);
    expect(pdf.rowCount).toBe(4);
    const text = Buffer.from(csv.bytes).toString("utf8");
    for (const payee of ["synthetic-alice", "synthetic-bob", "synthetic-charlie"]) expect(text).toContain(payee);
    const [header, ...rows] = text.trim().split(/\r?\n/).map((row) => row.split(","));
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const columns = Object.fromEntries(header!.map((name, index) => [name, row[index]]));
      expect(columns).toMatchObject({ native_value: "7000000000", native_decimals: "8", fiat_minor: "12345", fiat_currency: "USD" });
      expect(columns.transaction_hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(columns.immutable_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(columns.source_record).toMatch(/^BATCH-/);
      expect(columns.journal_entry).toMatch(/^ACC-JV-/);
      const identity = columns.batch_id === payroll.batchId ? identities.payroll
        : columns.batch_id === send.batchId ? identities.send
        : columns.batch_id === lostReply.batchId ? identities.lostReply : undefined;
      expect(identity).toMatchObject({ recordName: columns.source_record, jeName: columns.journal_entry });
    }
    expect(Buffer.from(pdf.bytes).subarray(0, 5).toString()).toBe("%PDF-");
    expect(createHash("sha256").update(csv.bytes).digest("hex")).toBe(csv.sha256);
    expect(createHash("sha256").update(pdf.bytes).digest("hex")).toBe(pdf.sha256);
    identities.export = { rowCount: csv.rowCount, csvSha256: csv.sha256, pdfSha256: pdf.sha256 };
    await writeFile("/tmp/acceptance-report.csv", csv.bytes);
    await writeFile("/tmp/acceptance-report.pdf", pdf.bytes);
  });

  it("rejects caller-selected GL accounts before sending any HTTP request", async () => {
    const before = proxy.requestCount;
    await expect(postJournalToFrappe({ ...send, glAccount: "Caller controlled" })).rejects.toThrow(/strict validation/);
    expect(proxy.requestCount).toBe(before);
  });
});
