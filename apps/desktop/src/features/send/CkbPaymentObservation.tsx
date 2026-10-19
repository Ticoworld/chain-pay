import { useEffect, useState } from "react";
import type { PaymentObservation } from "@/lib/chains/ckb/observe-payment";
import { connectPaymentObservation, type ObservationChain, type PaymentObservationSource } from "@/lib/chains/ckb/payment-observation-source";

type Inclusion = Extract<PaymentObservation, { state: "included" }>;
type History = { inclusion: Inclusion; session: object | null };
const waiting = (reason: string): PaymentObservation => ({ state: "uncertain", reason, checkedAt: Date.now() });

export function CkbPaymentObservation({ chain, txHash, connect = connectPaymentObservation }: {
  chain: ObservationChain;
  txHash: string;
  connect?: () => Promise<PaymentObservationSource>;
}) {
  const [enabled, setEnabled] = useState(false);
  const [observation, setObservation] = useState<PaymentObservation | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [session, setSession] = useState<object | null>(null);

  useEffect(() => { setHistory(null); }, [chain, txHash]);

  useEffect(() => {
    setObservation(null);
    if (!enabled) return;
    let stopped = false;
    let generation = 0;
    let busy = false;
    let rerun = false;
    let unsubscribe = () => {};
    let next: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    async function poll(source: PaymentObservationSource) {
      if (stopped) return;
      clearTimeout(next);
      if (busy) { rerun = true; return; }
      busy = true;
      const version = generation;
      const sampledSession = source.session();
      setSession(sampledSession);
      setObservation((previous) => previous ?? waiting("Checking the local chain view…"));
      deadline = setTimeout(() => {
        if (!stopped && version === generation) setObservation(waiting("Still waiting for local evidence."));
      }, 20_000);
      try {
        const result = await source.read(chain, txHash);
        if (!stopped && version === generation && sampledSession === source.session()) {
          setObservation(result);
          if (result.state === "included") setHistory({ inclusion: result, session: sampledSession });
        }
      } catch {
        if (!stopped && version === generation) setObservation(waiting("The light client is unavailable."));
      } finally {
        clearTimeout(deadline);
        busy = false;
        if (!stopped) next = setTimeout(() => void poll(source), rerun ? 0 : 5_000);
        rerun = false;
      }
    }
    void connect().then((source) => {
      if (stopped) return;
      unsubscribe = source.subscribe(() => {
        generation++;
        setSession(source.session());
        setObservation(waiting("The light-client session or selected network changed. Rechecking…"));
        void poll(source);
      });
      void poll(source);
    }).catch(() => { if (!stopped) setObservation(waiting("The light client is unavailable.")); });
    return () => { stopped = true; unsubscribe(); clearTimeout(next); clearTimeout(deadline); };
  }, [enabled, chain, txHash, connect]);

  return (
    <div className="space-y-1 text-xs text-fg-muted">
      <label className="flex gap-2">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        Check payment on CKB
      </label>
      {enabled && observation ? <p role="status">
        {observation.state === "included"
          ? `Latest local check: included in block ${observation.blockNumber}, at local tip ${observation.tipNumber}. Observed depth ${observation.localDepth}, including its block.`
          : `${observation.state === "pending" ? "Not yet observed in a block" : "Current check unavailable"}: ${observation.reason}`}
      </p> : null}
      {enabled && observation ? <p>Checked {new Date(observation.checkedAt).toLocaleTimeString()}.</p> : null}
      {enabled && history && observation?.state !== "included" ? <div aria-label="Last observed inclusion">
        <p>Earlier inclusion on {chain} — {history.session === session && session
          ? "this light-client session" : "a previous or inactive light-client session"}.</p>
        <p>Block {history.inclusion.blockNumber}, sampled tip {history.inclusion.tipNumber}; depth was {history.inclusion.localDepth} at {new Date(history.inclusion.checkedAt).toLocaleString()}. This is historical, not a current confirmation count.</p>
        <details><summary>Observation details</summary>
          <p className="break-all">Block hash: {history.inclusion.blockHash}</p>
          <p className="break-all">Sampled tip hash: {history.inclusion.tipHash}</p>
        </details>
      </div> : null}
      {enabled ? <>
        <p>Connectivity is unverified. The light client may return cached evidence.</p>
        <p>Observation only; it does not confirm this payment or post accounting. An unavailable check does not mean payment failure.</p>
      </> : null}
    </div>
  );
}
