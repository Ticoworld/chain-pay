import { useEffect, useState } from "react";
import { observePayment, type PaymentObservation } from "@/lib/chains/ckb/observe-payment";

type Chain = "ckb:mainnet" | "ckb:testnet";

async function readPayment(chain: Chain, txHash: string): Promise<PaymentObservation> {
  const [{ lightClient }, { useNetworkConfigStore }] = await Promise.all([
    import("@/lib/light-client/client"), import("@/stores/network-config"),
  ]);
  const reader = lightClient().paymentObservationReader();
  return observePayment({
    ...reader,
    currentNetwork: () => reader.currentNetwork() === useNetworkConfigStore.getState().network
      ? reader.currentNetwork() : null,
  }, chain, txHash);
}

export function CkbPaymentObservation({ chain, txHash, read = readPayment }: {
  chain: Chain;
  txHash: string;
  read?: typeof readPayment;
}) {
  const [enabled, setEnabled] = useState(false);
  const [observation, setObservation] = useState<PaymentObservation | null>(null);

  useEffect(() => {
    setObservation(null);
    if (!enabled) return;
    let stopped = false;
    let next: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      setObservation({ state: "uncertain", reason: "Checking local chain evidence...", checkedAt: Date.now() });
      deadline = setTimeout(() => {
        if (!stopped) setObservation({ state: "uncertain", reason: "Still waiting for the light client. No current status is available.", checkedAt: Date.now() });
      }, 20_000);
      try {
        const result = await read(chain, txHash);
        if (!stopped) setObservation(result);
      } catch {
        if (!stopped) setObservation({ state: "uncertain", reason: "Light client unavailable.", checkedAt: Date.now() });
      } finally {
        clearTimeout(deadline);
        if (!stopped) next = setTimeout(() => void poll(), 5_000);
      }
    }
    void poll();
    return () => { stopped = true; clearTimeout(next); clearTimeout(deadline); };
  }, [enabled, chain, txHash, read]);

  return (
    <div className="space-y-1 text-xs text-fg-muted">
      <label className="flex gap-2">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        Observe CKB network status (prototype)
      </label>
      {enabled && observation ? <p role="status">
        {observation.state === "included"
          ? `Light client reports inclusion in block ${observation.blockNumber}; local depth ${observation.localDepth} (including that block), at tip ${observation.tipNumber}.`
          : `${observation.state === "pending" ? "Local pending" : "Uncertain"}: ${observation.reason}`}
      </p> : null}
      {enabled && observation ? <p>Checked {new Date(observation.checkedAt).toLocaleTimeString()}.</p> : null}
      {enabled ? <p>Read-only local observation. Depth is provisional, not finality. This does not confirm payments or trigger accounting.</p> : null}
    </div>
  );
}
