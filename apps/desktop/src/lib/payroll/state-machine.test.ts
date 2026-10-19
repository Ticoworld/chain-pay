import { describe, expect, it } from "vitest";
import type { PayrollBatchState } from "@chain-pay/shared";
import { canTransition, assertCanTransition, isTerminal, terminalStates, nextStates } from "./state-machine";

describe("PayrollBatch state machine", () => {
  describe("canTransition", () => {
    it("allows draft → calculated", () => {
      expect(canTransition("draft", "calculated")).toBe(true);
    });

    it("allows calculated → approved", () => {
      expect(canTransition("calculated", "approved")).toBe(true);
    });

    it("allows approved → broadcasted", () => {
      expect(canTransition("approved", "broadcasted")).toBe(true);
    });

    it("allows broadcasted → confirmed", () => {
      expect(canTransition("broadcasted", "confirmed")).toBe(true);
    });

    it("allows broadcasted → failed (chain rejected)", () => {
      expect(canTransition("broadcasted", "failed")).toBe(true);
    });

    it("allows calculated → draft (revoke and re-edit)", () => {
      expect(canTransition("calculated", "draft")).toBe(true);
    });

    it("allows approved → calculated (revoke approval)", () => {
      expect(canTransition("approved", "calculated")).toBe(true);
    });

    it("allows cancellation from any non-terminal state", () => {
      expect(canTransition("draft", "cancelled")).toBe(true);
      expect(canTransition("calculated", "cancelled")).toBe(true);
      expect(canTransition("approved", "cancelled")).toBe(true);
    });

    it("forbids skipping straight from draft to broadcasted", () => {
      expect(canTransition("draft", "broadcasted")).toBe(false);
    });

    it("forbids skipping straight from draft to confirmed", () => {
      expect(canTransition("draft", "confirmed")).toBe(false);
    });

    it("forbids illegal transitions out of confirmed (only posting is allowed)", () => {
      expect(canTransition("confirmed", "draft")).toBe(false);
      expect(canTransition("confirmed", "calculated")).toBe(false);
      expect(canTransition("confirmed", "broadcasted")).toBe(false);
      expect(canTransition("confirmed", "cancelled")).toBe(false);
    });

    it("forbids transitions out of cancelled (terminal state)", () => {
      expect(canTransition("cancelled", "draft")).toBe(false);
      expect(canTransition("cancelled", "calculated")).toBe(false);
    });

    it("forbids cancellation of an already-broadcast tx (must wait for confirmed or failed)", () => {
      expect(canTransition("broadcasted", "cancelled")).toBe(false);
    });

    it("treats same-state as a no-op (forbids)", () => {
      expect(canTransition("draft", "draft")).toBe(false);
    });
  });

  describe("assertCanTransition", () => {
    it("throws with a useful message on invalid transition", () => {
      expect(() => assertCanTransition("draft", "broadcasted")).toThrow(/draft.*broadcasted/);
    });

    it("returns silently on valid transition", () => {
      expect(() => assertCanTransition("draft", "calculated")).not.toThrow();
    });
  });

  describe("terminalStates", () => {
    it("identifies posted, failed, cancelled as terminal (confirmed is no longer terminal)", () => {
      const terminals: PayrollBatchState[] = [...terminalStates];
      expect(terminals).toContain("posted");
      expect(terminals).toContain("cancelled");
      expect(terminals).toContain("failed");
      expect(terminals).not.toContain("confirmed"); // confirmed → posting is now valid
    });

    it("does not mark draft/calculated/approved/broadcasted/confirmed as terminal", () => {
      const terminals: readonly PayrollBatchState[] = terminalStates;
      expect(terminals).not.toContain("draft");
      expect(terminals).not.toContain("calculated");
      expect(terminals).not.toContain("approved");
      expect(terminals).not.toContain("broadcasted");
      expect(terminals).not.toContain("confirmed");
    });
  });

  describe("Phase 5 / Slice C: accounting-post lifecycle", () => {
    it("allows the accounting-post lifecycle", () => {
      expect(canTransition("confirmed", "posting")).toBe(true);
      expect(canTransition("posting", "posted")).toBe(true);
      expect(canTransition("posting", "post_failed")).toBe(true);
      expect(canTransition("post_failed", "posting")).toBe(true);
    });

    it("treats posted as terminal and blocks illegal post transitions", () => {
      expect(isTerminal("posted")).toBe(true);
      expect(canTransition("posted", "posting")).toBe(false);
      expect(canTransition("confirmed", "posted")).toBe(false); // must go via posting
    });
  });

  describe("2.7c auto-broadcast transitions", () => {
    it("allows approved → broadcast_countdown", () => {
      expect(canTransition("approved", "broadcast_countdown")).toBe(true);
    });

    it("allows broadcast_countdown → broadcast_initiating", () => {
      expect(canTransition("broadcast_countdown", "broadcast_initiating")).toBe(true);
    });

    it("allows broadcast_countdown → approved (cancel)", () => {
      expect(canTransition("broadcast_countdown", "approved")).toBe(true);
    });

    it("allows broadcast_countdown → broadcast_failed (onElapsed pre-check failure)", () => {
      // BUG 4 fix: onElapsed's three pre-checks (missing broadcastRpcUrl, no
      // txBytes, no partialSigs) call markBroadcastFailed while the batch is
      // still in broadcast_countdown. Before this transition was legal, the
      // store's canTransition guard silently discarded the call — no state
      // change, no broadcastError, no Retry button. See PayPanel.comm.test.tsx.
      expect(canTransition("broadcast_countdown", "broadcast_failed")).toBe(true);
    });

    it("allows broadcast_initiating → broadcasted", () => {
      expect(canTransition("broadcast_initiating", "broadcasted")).toBe(true);
    });

    it("allows broadcast_initiating → broadcast_failed", () => {
      expect(canTransition("broadcast_initiating", "broadcast_failed")).toBe(true);
    });

    it("allows broadcast_failed → broadcast_countdown (retryAutoBroadcast)", () => {
      expect(canTransition("broadcast_failed", "broadcast_countdown")).toBe(true);
    });

    it("keeps broadcast_failed → approved available for manual recovery", () => {
      expect(canTransition("broadcast_failed", "approved")).toBe(true);
    });

    it("disallows broadcasted reverts (terminal-ish, same as before)", () => {
      expect(canTransition("broadcasted", "broadcast_countdown")).toBe(false);
      expect(canTransition("broadcasted", "approved")).toBe(false);
    });

    it("disallows broadcast_countdown → broadcasted (must go via broadcast_initiating)", () => {
      expect(canTransition("broadcast_countdown", "broadcasted")).toBe(false);
    });

    it("nextStates(approved) includes broadcast_countdown", () => {
      expect(nextStates("approved")).toContain("broadcast_countdown");
    });
  });
});
