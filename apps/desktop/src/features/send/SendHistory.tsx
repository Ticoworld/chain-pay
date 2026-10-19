import { useState } from "react";
import { useSendsStore } from "@/stores/sends";
import { postSendJournal } from "@/lib/send/send-journal";
import { formatFiatMinor, parseFiatMajorToMinor } from "@/lib/send/fiat-value";
import type { SendRecord, SendState } from "@chain-pay/shared";
import { CkbPaymentObservation } from "./CkbPaymentObservation";

export function SendHistory() {
  const sends = useSendsStore((s) => s.sends);
  const sorted = [...sends].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <section className="space-y-4">
      <header>
        <h2 className="text-xl font-semibold">Send history</h2>
        <p className="text-sm text-fg-muted">
          Single-sig JoyID sends — confirming on-chain triggers accounting.
        </p>
      </header>
      {sorted.length === 0 ? (
        <p className="rounded-lg border border-dashed border-surface-hi bg-surface/50 p-6 text-center text-sm text-fg-muted">
          No sends yet. Use the send panel above to dispatch a payment.
        </p>
      ) : (
        <ul className="space-y-2">
          {sorted.map((s) => (
            <SendRow key={s.id} send={s} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SendRow({ send }: { send: SendRecord }) {
  const totalShannons = send.outputs.reduce((acc, o) => acc + o.amount.value, 0n);
  const totalCkb = Number(totalShannons) / 1e8;

  return (
    <li className="space-y-2 rounded-lg border border-surface-hi bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StateBadge state={send.state} />
            <span className="text-sm font-medium text-fg tabular-nums">
              {totalCkb.toFixed(4)} CKB
            </span>
            <span className="text-xs text-fg-muted">
              {send.outputs.length} output{send.outputs.length === 1 ? "" : "s"}
            </span>
            <span className="text-xs text-fg-muted">
              {new Date(send.createdAt).toLocaleDateString()}
            </span>
          </div>
          {send.txHash ? (
            <div className="mt-1 truncate font-mono text-xs text-fg-muted">
              tx: {send.txHash}
            </div>
          ) : null}
        </div>
      </div>

      {send.txHash ? <CkbPaymentObservation chain={send.chain} txHash={send.txHash} /> : null}

      {send.state === "posting" ? (
        <p className="text-xs text-fg-muted">Posting to accounting…</p>
      ) : null}

      {send.state === "posted" && send.journalEntryName ? (
        <p className="text-xs text-accent">Posted · {send.journalEntryName}</p>
      ) : null}

      {send.state === "broadcasted" ? (
        <button
          type="button"
          onClick={() => useSendsStore.getState().markConfirmed(send.id)}
          className="rounded-md border border-surface-hi bg-bg px-2 py-1 text-xs text-fg-muted hover:text-fg"
        >
          Mark confirmed
        </button>
      ) : null}

      {send.state === "post_failed" ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <p className="text-xs text-danger">{send.postError ?? "Post failed"}</p>
            <button
              type="button"
              onClick={() => void postSendJournal(send.id)}
              className="rounded-md border border-surface-hi bg-bg px-2 py-1 text-xs text-fg-muted hover:text-fg"
            >
              Retry accounting only
            </button>
          </div>
          {send.outputs.some((output) => output.fiat.minor <= 0n) ||
          send.postError?.includes("Accounting fiat value") ? (
            <AccountingValueEditor send={send} />
          ) : null}
        </div>
      ) : null}

      {send.outputs.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {send.outputs.map((o, i) => (
            <li key={i} className="flex items-center gap-2 text-xs text-fg-muted">
              <span className="truncate font-mono">{o.payeeAddress.slice(0, 20)}…</span>
              <span className="tabular-nums">
                {(Number(o.amount.value) / 1e8).toFixed(4)} CKB
              </span>
              {o.fiat.minor > 0n ? (
                <span>
                  ({o.fiat.currency} {formatFiatMinor(o.fiat.minor)})
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function AccountingValueEditor({ send }: { send: SendRecord }) {
  const [values, setValues] = useState(() =>
    send.outputs.map((output) =>
      output.fiat.minor > 0n ? formatFiatMinor(output.fiat.minor) : "",
    ),
  );
  const [error, setError] = useState<string | null>(null);

  function save(): void {
    const minorValues = values.map((value) => parseFiatMajorToMinor(value) ?? 0n);
    try {
      useSendsStore.getState().updateAccountingValues(send.id, minorValues);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save accounting values");
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-warn/40 bg-warn/10 p-3">
      <p className="text-xs text-fg">
        This committed payment has no fiat valuation. Enter the actual accounting
        value; ChainPay will post the existing transaction hash and will not broadcast again.
      </p>
      {send.outputs.map((output, index) => (
        <label key={`${output.payeeId}-${index}`} className="flex items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate">
            Output {index + 1} value ({output.fiat.currency})
          </span>
          <input
            aria-label={`Output ${index + 1} accounting value in ${output.fiat.currency}`}
            type="number"
            min="0.01"
            step="0.01"
            value={values[index] ?? ""}
            onChange={(event) =>
              setValues((current) =>
                current.map((value, i) => (i === index ? event.target.value : value)),
              )
            }
            className="w-32 rounded-md border border-surface-hi bg-bg px-2 py-1 text-right text-fg"
          />
        </label>
      ))}
      <button
        type="button"
        onClick={save}
        className="rounded-md border border-surface-hi bg-bg px-2 py-1 text-xs text-fg-muted hover:text-fg"
      >
        Save accounting value
      </button>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}

function StateBadge({ state }: { state: SendState }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${stateTone(state)}`}>
      {state}
    </span>
  );
}

function stateTone(state: SendState): string {
  switch (state) {
    case "draft":
      return "bg-surface-hi text-fg-muted";
    case "built":
      return "bg-warn/20 text-warn";
    case "signing":
      return "bg-warn/30 text-warn";
    case "broadcasted":
      return "bg-accent/40 text-accent-fg";
    case "confirmed":
      return "bg-accent text-accent-fg";
    case "posting":
      return "bg-accent/60 text-accent-fg";
    case "posted":
      return "bg-accent/80 text-accent-fg";
    case "post_failed":
      return "bg-danger/20 text-danger";
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}
