import type { PayrollBatchState } from "@chain-pay/shared";

/**
 * Allowed transitions for a payroll batch. Keys = current state, values =
 * states it may move to. Same-state transitions and any transition out of a
 * terminal state are explicitly disallowed (the caller almost always means
 * "I want to do nothing" or "the chain has rendered judgement and I have to
 * accept it").
 *
 * Diagram:
 *
 *   draft ─────► calculated ─────► approved ─────► broadcasted ─┬─► confirmed
 *     │  ◄─────────┘   │  ◄──────────┘                          │
 *     │                │                                        └─► failed
 *     │                ▼
 *     └──► cancelled ◄─┴──◄──── approved
 *
 *   broadcasted cannot revert to anything (the tx is in flight; chain decides).
 *   confirmed → posting → posted (terminal) | post_failed → posting (retry).
 *   posted/cancelled/failed are terminal; confirmed is NOT terminal.
 */
const TRANSITIONS: Record<PayrollBatchState, PayrollBatchState[]> = {
  draft: ["calculated", "cancelled"],
  calculated: ["approved", "draft", "cancelled"],
  approved: ["broadcasted", "broadcast_countdown", "calculated", "cancelled"],
  broadcast_countdown: ["broadcast_initiating", "broadcast_failed", "approved", "cancelled"],
  broadcast_initiating: ["broadcasted", "broadcast_failed"],
  broadcast_failed: ["broadcast_countdown", "approved", "cancelled"],
  broadcasted: ["confirmed", "failed"],
  confirmed: ["posting"],
  posting: ["posted", "post_failed"],
  post_failed: ["posting"],
  posted: [],
  failed: [],
  cancelled: [],
};

export const terminalStates: readonly PayrollBatchState[] = ["posted", "failed", "cancelled"];

export function canTransition(from: PayrollBatchState, to: PayrollBatchState): boolean {
  if (from === to) return false;
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertCanTransition(from: PayrollBatchState, to: PayrollBatchState): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `invalid payroll batch transition: ${from} → ${to} (allowed from '${from}': ${TRANSITIONS[from]?.join(", ") || "none"})`,
    );
  }
}

export function isTerminal(state: PayrollBatchState): boolean {
  return terminalStates.includes(state);
}

/** Allowed forward states from `from`. UI uses this to render transition buttons. */
export function nextStates(from: PayrollBatchState): PayrollBatchState[] {
  return TRANSITIONS[from] ?? [];
}
