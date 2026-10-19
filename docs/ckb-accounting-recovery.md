# CKB accounting retry and restart recovery

CKB sends and payroll batches keep `confirmedAt` separately from the lifecycle
`updatedAt`. Confirmation captures this value once; posting, failure, valuation
correction and restart recovery must preserve it. The current CKB confirmation
action is operator driven, so this timestamp records that action. It does not
prove a block timestamp or chain finality.

The accounting record includes `confirmedAt` in Frappe's immutable source digest.
Frappe commits the source record before journal posting. A failed request can
therefore leave a source record, and possibly its Journal Entry, on the server.
Every retry must send the same immutable data to recover those identities.
Using `updatedAt` would substitute the time of a failed post or restart and make
an otherwise valid retry conflict with the committed source.

For older records without `confirmedAt`, `markPosting` pins their existing
`updatedAt` before changing lifecycle state or contacting Frappe. The optional
field is persisted with the existing send or batch; no storage version change is
required. Direct record builders retain the legacy fallback, and normal posting
always passes through the store action that saves it.

On hydration, payroll batches left in `posting` become `post_failed`, exposing
the existing Retry action. Sends already have the same recovery step. Recovery
preserves the transaction identity and confirmation timestamp and waits for an
explicit accounting retry. It does not broadcast a transaction.

An older application may already have overwritten the only local copy of the
timestamp it sent to Frappe. Adding the field cannot reconstruct that historical
value. Such records can still encounter an immutable-data conflict and require
reconciliation against the server's source record. The same applies when other
immutable accounting values were changed after the server accepted them.

Regression coverage exercises elapsed time during a lost response, persisted
in-flight requests across a module reload, legacy confirmed records, confirmation
capture, valuation correction before any server request, and recovery guards for
vendor and completed batches. These checks concern accounting recovery; they do
not establish CKB confirmation depth, reorganization handling or recovery from an
interrupted chain broadcast.
