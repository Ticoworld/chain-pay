# Disposable accounting acceptance gate

Run the opt-in desktop-to-ERPNext rehearsal from a clean checkout:

```sh
npm run test:accounting:acceptance
```

Requires Node 22.12+, npm 10+ and Docker Engine with the Compose plugin, using Linux
containers. Compose must support `up --wait --wait-timeout` (validated with 5.0.2).
The host does not need Node dependencies, Python, Bash, ERPNext or
wallet software installed. The pinned stack is validated on Linux/amd64
containers (including Docker Desktop on Windows); ARM/macOS is unverified.
Docker needs network access to pull images and
install the committed npm lockfile. Allow several minutes and several GB of disk
space for the first run. A measured Windows run took about 19 minutes, dominated
by a 5.5-minute locked install and an 11-minute ERPNext site setup; downloads and
hardware can change this substantially. Use fast desktop/backend unit tests for
ordinary iteration and this full rehearsal before accounting integration review.
The runner works from PowerShell and Unix shells.

It uses digest-pinned Node 22.14.0, Frappe 15.123.1 / ERPNext 15.123.0,
MariaDB 10.6 and Redis 6.2 images. Update these deliberately and rerun the entire
gate when changing the backend baseline. This is a development fixture.

## What the command does

1. Creates a randomly named Compose project, starts its Node container and installs
   locked dependencies before starting ERPNext. This avoids leaving the backend
   idle through a potentially long download and separates install from HTTP failures.
   Backend startup then creates fresh database/site volumes.
   It publishes no ports and uses no existing backend configuration or volumes.
2. Installs the existing backend app in the official ERPNext image. The shared
   site bootstrap used by `scripts/backend-up.sh` creates/migrates the site and
   invokes the existing company/account seed and Journal Entry field helpers.
3. Creates disposable `example.invalid` API users: an Accounts User without
   System Manager, and an Employee without accounting roles. Welcome email is
   disabled. Generated credentials remain inside the disposable containers.
4. The dependency step copies test sources into a writable Node container and runs
   `npm ci --ignore-scripts` for desktop/shared from the committed lockfile, with no external cache
   volume. A failed install gets one retry using only that run's integrity-checked
   npm cache; download diagnostics remain in the stage log. No host dependency
   tree is used or modified. Install scripts are not
   needed: only Electron's shell module is mocked; its binary is not launched.
5. Waits for an authenticated, authorized accounting CSV request to return the
   exact expected HTTP 417 empty-data validation response on the fresh site.
   Other errors or a populated export fail readiness. A generic Frappe ping is insufficient application readiness.
   This bounded read-only probe creates no payment. Then it type-checks and lints
   the test and production imports, runs the proxy regression, and runs seven cases through
   the production payroll/send record builders, main-process HTTP functions,
   real Frappe HTTP authentication and ERPNext posting/report APIs.
6. Independently audits the database for exactly three submitted sources,
   three linked submitted journals, four payment lines, the expected accounts
   and exact balanced totals (USD 246.90, 123.45 and 123.45).
7. Runs tests and database audit again in a separate Node process against
   the same site, then compares identities, counts and CSV hashes. Typecheck and
   lint run once; replay uses the same unchanged sources and dependencies.
8. Removes only this project's containers, network and volumes, including on
   ordinary failures and interrupts. Sanitized artifacts remain on the host.

The seven cases cover two-payee payroll posting/replay; send posting/replay;
a successful reply deliberately dropped after the server finishes; rejection
of changes to an accepted source; invalid HTTP credentials and insufficient
Accounts roles; exact source amounts and CSV/PDF integrity; and rejection of
caller-selected GL fields before HTTP. The loss-of-reply proxy drains the real
server response before closing the client socket. Retry sends the frozen
accepted record and must return the original source and Journal Entry. The fault
is bound to the payment ID of the incoming request; a focused regression checks
that unrelated and late responses cannot consume it. Integration execution stops
after the first failure to avoid reporting dependent assertions as new defects.

## Artifacts and diagnostics

The command prints its unique project name and output directory:

`.cache/accounting-acceptance/chainpay-accounting-<random>/`

This directory is already ignored by Git. It contains startup/setup/readiness
logs, a separate locked-install log, first-run and replay test logs, independent database audits, sanitized
JSON identities, synthetic CSV/PDF reports, comparison result and cleanup log.
Each named stage prints pass/fail and elapsed seconds. `stages.json` records
the durations, first failing stage and cleanup result, so setup/download cost is
visible separately from the actual HTTP tests. Commands have a 15-minute ceiling;
the locked install allows 30 minutes and cleanup allows 60 seconds. A timed-out
Docker CLI is terminated, then project cleanup is attempted. If the daemon is
unresponsive, the printed emergency command remains necessary.

Check the failing stage's log if the command exits nonzero. Npm registry/network
failures do not establish an application failure. ERPNext can emit a Tax Rule
fixture warning during company setup; passing additionally requires actual
submitted journals and reports. Completed-response path/status/duration evidence is saved
in the summaries; a request without a completed response may have no timing entry.
The runner also attempts to retain a failure summary and `failure-http.log`
before cleanup. The latter extracts only method/path/status and exception class
from the server log's last 200 lines, retaining at most 30 events. Request bodies,
headers, query strings and exception messages are omitted; a missing log or an
unavailable backend is reported as a diagnostic-stage failure. It does not copy
the raw server log. Production
HTTP deadlines remain unchanged; a stalled posting request still fails the gate.

Credentials transfer directly between containers over Docker stdin. They are
never command-line arguments, host files or captured artifacts. The fixed
database/admin password in Compose is only for this disposable network.
Do not replace it with production credentials or point these fixtures at a real
organization. No application `FRAPPE_*` configuration is consumed by the runner.
Compose uses an empty environment file. There is no remote-server option.

After host power loss or a Docker daemon failure, use the printed emergency
cleanup command with the exact project name:

```sh
docker compose -p <printed-project> -f tests/accounting-acceptance/compose.yml down --volumes --remove-orphans
```

Do not use a global volume prune. Each normal invocation creates a new site.
No expensive mandatory CI job is added. Ordinary desktop/shared tests retain
their configuration and do not discover this opt-in test directory.

## Scope and limits

Fixtures use invented transaction hashes and synthetic payees on the current
site date, matching the existing seed's fiscal year. They are accounting input,
not evidence of settlement. This does not launch Electron, exercise preload IPC,
renderer stores/reactors, confirmation/restart behavior, wallets or any chain.
It does not certify CKB finality or the separate BTC/SOL/Safe live gates. It does
not replace the CKB retry timestamp regressions in PR #21.

Frappe retains account derivation and immutable source validation. No financial
policy or API is added. CSV assertions use controlled comma-free fixture fields.
PDF bytes, header and SHA-256 integrity are checked; visual layout is unverified.
The HTTP proxy supplies internal site Host routing, so normal desktop URL and
operator setup remain separate checks.

Maintain this fixture alongside domain-record, backend-policy and compliance
format changes. Extend the existing accounting functions and server fixtures
instead of adding a parallel posting implementation or SDK.
