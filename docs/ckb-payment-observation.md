# CKB payment observations

In Send history, enable **Check payment on CKB** for a saved send. While that
card is enabled and mounted, ChainPay checks its embedded light client five
seconds after the preceding check finishes. No external RPC, new indexer,
watch-script change or rescan is required.

## Reading the display

- **Latest local check** reports inclusion in the sampled local chain, with its
  block, tip and observed depth (including the inclusion block). This is a
  light-client report, not a current network-wide confirmation or finality claim.
- **Current check unavailable** explains missing evidence, stale local tip,
  changed session, conflicting ancestry or the bounded history limit.
- **Earlier inclusion** retains the last successful observation in this mounted
  card: original block/hash, sampled tip/hash, depth and time. Its depth is
  explicitly historical. A stopped, restarted or mismatched session is qualified
  as previous/inactive. Changing the saved payment/network clears this history.
- **Connectivity is unverified.** The client can return cached headers,
  transaction associations and peer metadata while transport is disconnected.
  Neither peer rows nor a recent tip establishes an online or synchronized state.

An unavailable check does not mean payment failure or permission to resend.
Observation never changes persisted send states, confirmation times or journals,
and never signs, constructs or broadcasts a transaction. The existing manual
confirmation action remains separate and invokes the existing accounting flow.
Disabling observation stops its timer/subscription; history is not persisted and
is discarded when the card unmounts. Background light-client synchronization is
owned by the existing host.

## Evidence and work bounds

The observer checks saved/returned transaction identity, inclusion header,
continuous parent hashes, sampled-tip stability and transaction association.
It checks at most 64 parent links (local depth 65). Older payments retain earlier
inclusion as history, but receive no newly calculated depth beyond this budget.
A five-minute tip-age and one-minute future-clock tolerance withhold current
results; these are UI freshness heuristics, not consensus or connectivity rules.

One reader per native session shares up to 256 immutable headers with LRU
eviction and deduplicates equal in-flight queries. At most 32 distinct queries
can be pending through that reader. Missing/mismatched headers are not cached.
Only successful ancestry relationships for exact tip/block hashes are reused
(up to 64 pairs per reader); mutable transaction associations are still reread.
New tips and changed inclusion hashes require a new bounded ancestry check.
The cache does not assert that an old block remains canonical just because it
exists. Stop/restart discards session caches; old readers reject even cached reads.

Each card has one outstanding check. A hanging request shows uncertainty after
20 seconds without issuing overlapping checks. Native calls are not cancellable;
disable/unmount ignores late replies, and session stop rejects outstanding
observation queries. Lifecycle/configuration changes immediately invalidate the
display and old replies cannot restore its current result. No global watcher,
new database, runtime dependency or mandatory CI job is added.

The normalized LC API does not expose the original Merkle proof/validation anchor
or a reliable transport-health signal. This feature cannot independently certify
native cache correctness or all reorganizations, nor force cached transactions
to be reproved. A cached locally pending transaction can still depend on existing
watched-script scanning to discover inclusion. Payroll observation is omitted
because those records do not freeze a payment network.

## Verification

After the normal locked dependency setup:

```sh
npm --workspace apps/desktop test -- observe-payment.test.ts observation-reader.test.ts payment-observation-source.test.ts CkbPaymentObservation.test.tsx host.observation.test.ts SendHistory.test.tsx --maxWorkers=2
npm --workspace apps/desktop run typecheck
npm --workspace apps/desktop run lint
```

Controlled tests cover current/history separation, expiry, conflicting ancestry,
session/network isolation, hanging reads, bounded caches, deduplication and the
unchanged accounting boundary. They do not simulate CKB consensus. Real browser
acceptance uses already committed public testnet transactions and the pinned
WASM client; it does not prove settlement intent, a full Electron GUI session,
native reorganization recovery or automatic confirmation safety.
