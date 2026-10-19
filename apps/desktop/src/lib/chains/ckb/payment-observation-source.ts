import { observePayment, type PaymentObservation } from "./observe-payment";

export type ObservationChain = "ckb:mainnet" | "ckb:testnet";
export interface PaymentObservationSource {
  session(): object | null;
  read(chain: ObservationChain, hash: string): Promise<PaymentObservation>;
  subscribe(listener: () => void): () => void;
}

const sessionIdentities = new WeakMap<object, object>();
function sessionIdentity(reader: object): object {
  const identity = sessionIdentities.get(reader) ?? {};
  sessionIdentities.set(reader, identity);
  return identity;
}

export async function connectPaymentObservation(): Promise<PaymentObservationSource> {
  const [{ lightClient }, { useNetworkConfigStore }] = await Promise.all([
    import("@/lib/light-client/client"), import("@/stores/network-config"),
  ]);
  const host = lightClient();
  let native: ReturnType<typeof host.paymentObservationReader> | undefined;
  let guarded: typeof native;
  return {
    session: () => host.isStarted() && host.currentNetwork() === useNetworkConfigStore.getState().network
      ? sessionIdentity(host.paymentObservationReader()) : null,
    read: (chain, hash) => {
      const reader = host.paymentObservationReader();
      if (reader !== native) {
        native = reader;
        guarded = {
          ...reader,
          currentNetwork: () => reader.currentNetwork() === useNetworkConfigStore.getState().network
            ? reader.currentNetwork() : null,
        };
      }
      return observePayment(guarded!, chain, hash);
    },
    subscribe: (listener) => {
      const session = host.onSessionChange(() => {
        native = undefined;
        guarded = undefined;
        listener();
      });
      const network = useNetworkConfigStore.subscribe((state, previous) => {
        if (state.network !== previous.network) listener();
      });
      return () => { session(); network(); };
    },
  };
}
