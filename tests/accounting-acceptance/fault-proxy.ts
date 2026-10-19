import { createServer, request } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export function createFaultProxy(hostname: string, port: number, site: string) {
  let targetBatch: string | undefined;
  let droppedReply: unknown;
  let requestCount = 0;
  const timings: { path: string; status: number; elapsedMs: number; dropped: boolean }[] = [];
  const upstreams = new Set<ReturnType<typeof request>>();

  async function forward(incoming: IncomingMessage, outgoing: ServerResponse) {
    const started = performance.now();
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const batchId = incoming.method === "POST" ? JSON.parse(body.toString("utf8")).record?.batchId : undefined;
    const drop = targetBatch !== undefined && batchId === targetBatch
      && incoming.url === "/api/method/crypto_payroll.api.post_confirmed_payment";
    if (drop) targetBatch = undefined;
    const upstream = request({
      hostname, port, path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, host: site, connection: "close" },
    }, (response) => {
      const responseChunks: Buffer[] = [];
      response.on("data", (chunk) => responseChunks.push(Buffer.from(chunk)));
      response.on("error", () => outgoing.destroy());
      response.on("end", () => {
        const bytes = Buffer.concat(responseChunks);
        const discarded = drop && response.statusCode === 200;
        timings.push({ path: incoming.url ?? "", status: response.statusCode ?? 502,
          elapsedMs: Math.round(performance.now() - started), dropped: discarded });
        if (discarded) {
          droppedReply = JSON.parse(bytes.toString("utf8")).message;
          outgoing.destroy();
        } else if (!outgoing.destroyed) {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          outgoing.end(bytes);
        }
      });
    });
    upstreams.add(upstream);
    upstream.on("close", () => upstreams.delete(upstream));
    upstream.on("error", () => { if (!outgoing.destroyed) { outgoing.writeHead(502); outgoing.end(); } });
    upstream.end(body);
  }

  const server = createServer((incoming, outgoing) => {
    requestCount += 1;
    void forward(incoming, outgoing).catch(() => { outgoing.writeHead(502); outgoing.end(); });
  });
  return {
    timings,
    get requestCount() { return requestCount; },
    get droppedReply() { return droppedReply; },
    dropResponseFor(batchId: string) { targetBatch = batchId; },
    async listen() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    },
    async close() {
      for (const upstream of upstreams) upstream.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
