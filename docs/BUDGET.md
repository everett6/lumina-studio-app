# Spending controls

Lumina's ledger is an estimate-based guard, not a provider invoice cap. The default total ceiling is $12, with $1 protected for eligible retries. This change preserves existing budget settings, the spending start date, and ledger amounts. Deleting a project does not erase its spending. No provider limit is raised, reset or topped up by these controls.

Before queuing a paid request, Lumina checks its estimate against the configured total, daily, project and per-request limits. Authorization, approval consumption, job creation and reservation happen under one SQLite `BEGIN IMMEDIATE` transaction. Different connections cannot both reserve the same remaining allowance. A paid request without a finite estimate is refused with a suggestion to use a local model, even if strict prices or budget enforcement were disabled. An approval or a per-request limit cannot turn an unknown provider price into a bounded cost. The old assumed speech price is no longer used to admit paid speech.

The budget response separates:

- `estimatedUsd`: original estimates for ledger entries in the selected spending period, including released entries; this is planning information, not an additional charge.
- `reservedUsd`: money held for outstanding requests.
- `chargedUsd`: completed charges reported by providers, or the estimate when no charge was reported.
- `unknownUsd`: money retained for unresolved billing.
- `spentUsd`: reserved + charged + unknown, counted against the ceiling.

Each job stores its initial state, request fingerprint and retry lineage in `params.accounting`; lifecycle state and provider request ids live in `providerJob.billingState` and `providerJob.requestIds`. These use existing JSON columns; legacy scalar accounting fields remain readable. `not_submitted` means it has not entered a paid submission. Submission intent is persisted as `billing_unknown` before the adapter can send a POST. `submitted` records provider acceptance and every available request id. `completed_remote` means the remote result exists. `download_failed` means retrieving or saving that result failed. All four uncertain states retain their reservation. A successful job becomes `charged` (or `completed` for free work). Only a confirmed pre-submission refusal or explicit reconciliation to zero makes it `confirmed_unbilled`. The legacy `billing` field remains available for existing clients.

A timeout or lost connection does not prove that the provider did no work. Cancelling after submission stops tracking or local waiting; it cannot undo a remote charge. A later download authentication error, a failed poll, or a partial/zero usage figure on a failed request never releases the original reservation.

Polling, result-document reads, downloads and local saving use at most three attempts, with 100 ms then 200 ms backoff after errors. Paid generation POSTs are never automatically retried. On restart, queued work resumes; accepted remote requests resume polling or downloading their saved result when the adapter has usable recovery information. An unusable marker, a synchronous response lost before storage, or an ambiguous submission without an id remains unresolved instead of becoming another generation POST. Streaming speech responses without a reusable download endpoint cannot be fetched again safely; their reservation remains held if the stream is lost.

An idempotency key identifies the normalized operation, provider, model, prompt, parameters, input asset ids and prompt director. Sending the same key with different inputs returns HTTP 409. Duplicate queue entries are claimed only once. Keep the same key when re-sending a request after a client connection failure.

`isRetry: true` requires `retryOf`, naming a failed/interrupted job in the same project and operation whose billing is `confirmed_unbilled` or `refused`; a bare retry flag returns HTTP 400. Reusing a book target alone does not grant access to the protected retry reserve. Check the provider's records and reconcile the prior charge before requesting an eligible retry. An explicit app-only `confirmUncertain` action can instead buy a new request at the normal ceiling: it does not release or reconcile the old reservation and cannot use the protected retry reserve. Background and MCP callers cannot use that action to bypass uncertain billing.

OpenRouter's `keyRemainingUsd` is the configured key's allowance, separately reported from `accountRemainingUsd`. A normal generation key does not expose the account balance; `accountStatus` explains that restriction. If a remaining key allowance cannot be read, it is `unavailable` with a null amount, never zero or an invented balance. Preflight refuses new OpenRouter submissions unless the allowance covers outstanding reservations and the protected retry reserve. Resuming an already accepted request does not need a new allowance check.

Provider-enforced account/key limits, billing rules and invoices remain the provider's responsibility. Lumina does not configure those limits, and price changes, provider adjustments, other applications using the same account, or differences between estimates and final charges can make invoices differ from this ledger. Use the provider's own controls for an invoice cap. These changes use only read-only allowance endpoints and do not purchase credits or alter account limits.
