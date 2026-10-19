import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createFaultProxy } from "./fault-proxy";

it("drops only the targeted request despite an unrelated late response", async () => {
  let releaseOld: () => void = () => undefined;
  let receivedOld: () => void = () => undefined;
  const oldReceived = new Promise<void>((resolve) => { receivedOld = resolve; });
  let accepted = false;
  const backend = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const batchId = JSON.parse(Buffer.concat(chunks).toString()).record.batchId;
    if (batchId === "old") {
      receivedOld();
      await new Promise<void>((resolve) => { releaseOld = resolve; });
    }
    if (batchId === "target") accepted = true;
    outgoing.setHeader("Content-Type", "application/json");
    outgoing.end(JSON.stringify({ message: { record_name: batchId, je_name: "journal-" + batchId } }));
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const proxy = createFaultProxy("127.0.0.1", (backend.address() as AddressInfo).port, "fixture.localhost");
  try {
    const url = await proxy.listen();
    const post = (batchId: string) => fetch(url + "/api/method/crypto_payroll.api.post_confirmed_payment", {
      method: "POST", body: JSON.stringify({ record: { batchId } }),
    });
    const old = post("old");
    await oldReceived;
    proxy.dropResponseFor("target");
    expect((await post("unrelated")).status).toBe(200);
    releaseOld();
    expect((await old).status).toBe(200);
    await expect(post("target")).rejects.toThrow();
    expect(accepted).toBe(true);
    expect(proxy.droppedReply).toEqual({ record_name: "target", je_name: "journal-target" });
    expect((await post("target")).status).toBe(200);
    expect(proxy.timings.filter((timing) => timing.dropped)).toHaveLength(1);
  } finally {
    releaseOld();
    await proxy.close();
    backend.closeAllConnections();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  }
});
