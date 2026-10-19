# CKB payment observation prototype

This experimental slice adds a separate network-status display to Send history.
For a saved transaction, enable **Observe CKB network status (prototype)**.
It polls the embedded light client every five seconds after the previous check
finishes, only while enabled and mounted. It does not change payment records,
confirmation timestamps, journal posting or broadcast behavior. The existing
manual confirmation control still invokes the existing accounting workflow.

The display reports local pending evidence, reported inclusion with local depth,
or uncertainty with a reason. Depth includes the inclusion block and is relative
to one sampled local tip, not a finality threshold or a globally current tip.
It requires matching transaction/hash/header data, continuous parent headers,
a stable sampled tip, connected peers and a recent tip timestamp. Missing data,
session/network changes and conflicting ancestry withhold the count. Disappearing
evidence never means a payment failed or should be sent again.

No remote full-node RPC fallback, watcher changes, rescan or database migration is
introduced. The existing light-client fetch APIs can request transaction/header
proofs and update the recoverable LC cache. These are peer reads, not financial
actions. A local pending transaction can still depend on watched-script scanning
to discover its inclusion: fetchTransaction can return the existing pending cache.

The prototype checks at most 64 parent links (up to local depth 65). Older
inclusions are reported as uncertain instead of walking an unlimited history.
The five-minute tip-age and one-minute future-clock checks are conservative UI
heuristics, not consensus rules. Hanging reads show uncertainty after 20 seconds;
the native worker request is not cancellable and no overlapping poll is started
within that mounted observation. Disabling/unmounting clears timers and ignores
late results; already requested peer/cache work may continue.
Stopping the native session rejects outstanding observation queries so a worker
terminated before replying cannot permanently stall observation after restart.
This cancellation wrapper applies only to the read-only observation port.

The LC API returns normalized transaction/block associations, not a raw Merkle
proof and its validation anchor. Parent traversal validates the reported block's
relationship to the sampled tip; it cannot independently certify transaction
membership, cache correctness or all reorganizations. Inclusion is therefore
labeled as a light-client report. This slice must not drive accounting or finality.

Payroll is deliberately omitted: batches retain a treasury ID and transaction
hash but do not freeze network identity. Inferring old payment networks from an
editable/deleted treasury would extend the scope and weaken the result.

Focused verification (after the project's normal locked dependency setup):

~~~sh
npm --workspace apps/desktop test -- observe-payment.test.ts CkbPaymentObservation.test.tsx host.observation.test.ts SendHistory.test.tsx --maxWorkers=2
npm --workspace apps/desktop run typecheck
npm --workspace apps/desktop run lint
~~~

Tests exercise the actual observer, host session wrapper, polling UI and existing
accounting reactor using controlled LC responses. They are not a live WASM/P2P
test or a simulation of CKB consensus. Before proposing release, run browser LC
acceptance with an already broadcast recent transaction, measure parent-header
availability and verify disconnect/reconnect, restart and an isolated fork.
No new payment or real signing credentials are needed for the first check.
