# Production Design

How this exercise would evolve into a production financial-services system.

Each section marks status: **[Implemented]** in this assessment, **[Proposed]** for production, **[Postponed]** a deliberate tradeoff.

SQLite and the database-backed job table are **exercise infrastructure, not a target architecture.** They were kept because the assessment requires preserving the stack and one-command setup.

## 1. Trust boundaries

Three boundaries, each with a different threat model:

| Boundary | Today | Production |
|---|---|---|
| Customer → API | `x-customer-id` header, caller-controlled | Session or OIDC token; `customerId` derived from a verified claim, never from a request header |
| Partner → API | Unauthenticated | mTLS or signed requests, replay protection, per-partner rate limits |
| API → Worker | Shared database table | Same durable-outbox semantics, moved to managed infrastructure |

**[Implemented]** Ownership is enforced inside the read query rather than by filtering results afterwards, which prevents this specific ownership bypass: a caller-supplied identity can no longer select another customer's application. It is not a general guarantee against future authorization defects. A non-owner and an unknown application return an identical `404`, so existence is not disclosed.

**Ownership enforcement is not authentication.** The implemented check answers "does this application belong to the stated customer"; nothing answers "is the caller that customer". `x-customer-id` remains caller-controlled, so the reproduced cross-customer read is closed while identity remains unverified. These are two different controls and only one is implemented.

**[Proposed — production blocker]** Customer authentication: replace the caller-controlled header with a verified session or token, derive `customerId` from authenticated claims, and keep the ownership predicate in the database query. The service signature already takes `customerId` as a separate argument, so the change is confined to how that value is obtained — the authorization logic does not move. No authentication mechanism is implemented in this assessment.

**[Postponed]** Role-based access for staff and operations users; the exercise has one actor type.

## 2. Partner authentication and replay protection

The partner endpoint accepts writes from any caller that can reach it. Event idempotency (§3) makes a *replayed* delivery harmless to domain state, but it does nothing about an unauthenticated caller forging a *new* event.

**[Proposed — production blocker]** Partner authentication: a production-appropriate authenticated integration (mTLS, or requests signed over the raw body), with timestamp and nonce or equivalent replay protection, and the accepted partner identity bound to the integration and application scope it is permitted to write. No partner authentication is implemented in this assessment.

**[Postponed]** Per-partner key rotation and a partner management surface.

## 3. Event ingestion and idempotency scope

**[Implemented]** Uniqueness is enforced by database constraints, not by a read-before-write check:

- history: `@@unique([applicationId, sourceEventId])`
- notification intent: `@@unique([applicationId, sourceEventId, type])`

Scope is **per application**, because `docs/DOMAIN.md` does not guarantee partner-feed-global uniqueness. This is a recorded assumption (ISSUES.md A1) requiring confirmation in the partner contract.

**Feed-global uniqueness is the stricter constraint.** Adopting it without a confirmed partner contract risks rejecting legitimate events. Moving to it later requires auditing and resolving every existing cross-application `sourceEventId` collision, which is legal under the current scope. Relaxing in the other direction is always satisfied by existing data. Absent contract evidence the weaker per-application guarantee is the safer default.

Ingestion evaluates in a fixed order — **duplicate, then staleness, then transition validity** — so a partner retrying an already-accepted event always receives `duplicate` rather than a misleading `stale` or `invalid_transition`.

If two deliveries interleave past the read check, the losing transaction fails on the unique index. The service maps that to a duplicate outcome **only** for the two known event-uniqueness constraints, matched on Prisma's `meta.modelName` and `meta.target`; any other `P2002` is rethrown. A probe against SQLite confirmed those fields are populated and distinguish the constraints (`{modelName: 'ApplicationStatusHistory', target: ['applicationId','sourceEventId']}`). The check fails closed: if that metadata were ever absent, the error is rethrown as a `500` rather than silently reported as a duplicate.

**Limitation — an `eventId` reused with a different payload is treated as a duplicate.** The duplicate check matches `(applicationId, sourceEventId)` and returns before comparing status, `occurredAt` or `reason`. A partner that reuses an event id with different content receives `duplicate`, and the conflicting content is silently discarded rather than surfaced. This is correct only under the unstated assumption that one event id permanently identifies one immutable payload.

**[Proposed]** Distinguish the two cases: compute a canonical fingerprint over the immutable event fields, persist it with the accepted ingestion record, and compare on the next delivery. Same id and same fingerprint is a `duplicate`; same id and a different fingerprint is an `event_id_conflict` — return a conflict response, retain an audit record, and emit a metric or alert. If the contract defines event ids as immutable, a conflict indicates a partner-contract violation; otherwise the contract is underspecified and needs a product decision. Neither the fingerprint column nor the outcome exists in the current schema or implementation.

**[Proposed]** A separate ingestion audit table recording every delivery — including rejected ones — with outcome, received timestamp and partner identity. Customer-visible history stays clean while operations keep full evidence of what the partner sent. This is the main thing missing from the current design: today a rejected delivery leaves no trace beyond a log line.

## 4. Ordering and versioning

**[Implemented]** `lastEventOccurredAt` is now read, not merely written. An event at or before it is `stale` and mutates nothing, so current state describes the newest accepted business event rather than the last request received. Equal timestamps resolve first-accepted-wins.

**[Proposed]** Partner timestamps are not a trustworthy ordering key across clock domains. Production should require a **monotonic per-application sequence number** in the partner contract and order on that, keeping `occurredAt` for display and audit only.

**[Proposed]** Out-of-order arrival is only partially handled. A newer event that arrives before its missing prerequisite is rejected as an invalid transition and is **not** reconsidered when the prerequisite later arrives — nothing buffers or replays it. Closing that gap needs partner sequence numbers, gap detection, quarantine or buffering of events that arrive early, and a reconciliation or replay path to drain the quarantine once the gap fills.

**Limitation — the uniqueness constraints do not serialize different event ids.** They protect event *identity*, not application state. Two concurrent deliveries carrying different `eventId` values can both read the same application row, both pass staleness and transition validation, and both write. SQLite serialized these writes in the exercise environment; that is a property of this database, not proof that the production race is closed.

**[Proposed]** Optimistic concurrency is the primary proposal: add a `version` column and make the state update a compare-and-set on the version read at the start of the transaction, retrying a bounded number of times when it loses. The alternative is per-application serialization in the ingestion layer, which is simpler to reason about but couples throughput to partitioning. The choice depends on the production database and ingestion architecture; neither is implemented.

**[Postponed]** Future-dated events (ISSUES.md DOM-1). Now that ordering is enforced, an event dated 2099 would advance `lastEventOccurredAt` beyond any legitimate future event and freeze the application. This is a real hazard the current implementation does not address. The proposal is to **reject or quarantine** timestamps outside an agreed clock-skew tolerance, always preserve the original partner timestamp in the ingestion audit, record server receipt time separately, and emit a metric or alert. Silently clamping to receipt time is explicitly rejected: it would destroy evidence of what the partner actually submitted. The tolerance and the reject-versus-quarantine choice require a product and partner-contract decision before production.

## 5. Transition validation

**[Implemented]** The lifecycle from `docs/DOMAIN.md` is an explicit table in `packages/contracts`, with `canTransition` and `isTerminalStatus`. Illegal transitions return `409` and mutate nothing. The table has no self-loops, so a same-state event is invalid (assumption A4).

The diagram's two branch arrows both target `DECLINED`, but their column alignment is ambiguous and too brittle to serve as a product rule. The table therefore follows the defensible business reading: an application may be declined from `IN_REVIEW` or from `OFFERED`. A decline directly from `SUBMITTED`, before any review has happened, has no unambiguous support in `docs/DOMAIN.md` and is left out pending product confirmation (assumption A9).

**[Proposed]** Version the transition table alongside the partner contract, and treat a change to it as a product decision with a migration plan for in-flight applications.

## 6. Transactional outbox

**[Implemented]** Application state, history and notification intent are written in one `$transaction`. Either all three exist or none do. This is the transactional-outbox pattern: the notification *intent* is committed atomically with the state change that justifies it, so **state cannot commit without intent in the same transaction**. That is a statement about this write path only — it says nothing about whether the intent is later delivered, which is the separate and currently broken concern in §7.

**[Proposed]** In production the outbox row is relayed to a real broker (SNS/SQS, Kafka) by a dedicated relay process. The API keeps writing only to its own database in one transaction; nothing calls a provider inline.

## 7. Notification delivery semantics

**Precise language matters here.** This assessment delivers **idempotent event ingestion** and **durable notification intent**. It does **not** deliver exactly-once delivery, and no part of the system should be described that way.

**[Postponed — and this is a release blocker]** Worker reliability (ISSUES.md NOTIF-1, NOTIF-2). Today a failed delivery is marked `processedAt` and never retried. **The selected slice does not mitigate this**: fewer duplicate and invalid intents are created, but a legitimate notification whose delivery fails is still lost silently. This must be fixed before production.

The target design, which was deliberately not partially implemented because these parts are only correct together:

- **At-least-once delivery** with consumer-side idempotency, never a claim of exactly-once.
- **Retry policy:** capped exponential backoff with full jitter (base 1s, factor 2, cap 15min, max ~8 attempts), stored as `nextAttemptAt`. Jitter matters because a provider outage otherwise produces synchronized retry storms from every queued job.
- **Claim/lease:** a conditional `UPDATE ... WHERE id = ? AND lockedUntil < now()` returning affected-row count, so exactly one worker owns a job for a bounded lease. The current `findMany`-then-`update` is check-then-write and double-sends under concurrency. Leases expire, so a crashed worker's jobs return to the queue without operator action.
- **Provider idempotency key:** must identify the **logical notification** — `applicationId + sourceEventId + notificationType` — not the job row id. A key derived from job identity generates a new delivery identity whenever a job is replayed or reconstructed, which defeats provider-side deduplication precisely when it is needed.
- **Exhaustion and dead letter:** after max attempts a job moves to a terminal `DEAD_LETTER` state with its last error retained. Exhausted work must be *visible*; silent discard is the current defect.
- **Operator replay:** an authenticated endpoint to inspect and re-enqueue dead-lettered jobs, resetting attempt count while preserving the original idempotency key so replay cannot duplicate a delivery the provider already accepted.

**[Proposed]** Worker lifecycle: drain in-flight work on `SIGTERM` within a grace period, then exit. Today `shutdown()` sets a flag but neither drains nor exits, and a throw escaping the batch loop exits the process with unprocessed work.

## 8. Sensitive data and log redaction

**[Implemented]** The partner acknowledgement carries only `outcome`, `eventId` and `applicationId`. Previously it returned the full customer record — name, email, phone and complete history. Scoped to the documented purpose of the acknowledgement, which is to tell the partner how its delivery was handled, that response disclosed substantially more data than the endpoint requires. The repository does not define the partner's permitted data scope, so this is data minimization against the documented purpose rather than a finding that the partner was forbidden the data (ISSUES.md A7).

**[Postponed]** Log redaction (ISSUES.md PII-2). Two distinct problems: the mock provider writes the customer email directly to stdout, and the API logs the partner `reason` free-text field, which may contain personal or sensitive data and has no redaction control.

**[Proposed]** A structured logger with an explicit field allowlist; identifiers logged, contact data never. Treat partner free text as untrusted and unredactable — log a hash or omit it. Set log retention deliberately rather than by default.

## 9. Immutable auditability

**[Implemented]** History rows are append-only in practice — nothing in the codebase updates or deletes them — and only accepted business transitions are recorded. Rejected deliveries never enter customer-visible history. Ordering is deterministic (`occurredAt`, then `recordedAt`, then `id`).

**[Proposed]** Enforce immutability rather than relying on convention: database permissions that deny `UPDATE`/`DELETE` on the history table, and periodic reconciliation asserting that the newest history row's status equals the application's current status. That reconciliation is the detective control for the atomicity failure the transaction now prevents.

## 10. Observability

**[Proposed]** A correlation id per request, propagated to the notification job and to provider calls, so one partner delivery can be traced end to end.

Metrics that would have caught the defects in `ISSUES.md`:

| Metric | Catches |
|---|---|
| Ingestion outcomes by kind | A partner suddenly producing `stale` or `invalid_transition` — contract drift |
| Duplicate rate | Partner retry storms |
| Notification attempts, failures, dead-letter depth | NOTIF-1, which is invisible today |
| Oldest unprocessed job age | A stalled or crashed worker |
| History-vs-state divergence count | Atomicity violations |

**Alerts:** dead-letter depth above zero; oldest-unprocessed-job age beyond threshold; any divergence. **[Proposed]** `/health` remains a liveness probe; add a separate readiness endpoint that verifies database connectivity, since a process that cannot reach its database should leave the load-balancer pool.

## 11. Deployment, migrations and rollback

**[Postponed]** Migration history (ISSUES.md OPS-2). `db:reset` uses `prisma db push --accept-data-loss`, which is acceptable for a local exercise and unacceptable in production: no reviewable diff, no rollback path, and data loss is in the command name. The unique constraints added here were applied by `db push` against a fresh database, so they have no migration file.

**[Proposed]** `prisma migrate` with checked-in migrations. Migrations run as their own deploy step, but **ordering matters**: the constraint-adding migration must follow the compatible API, not precede it. The sequence below is the authoritative ordering.

**Adding the uniqueness constraints to a live database** needs an expand/contract sequence, because production data may already contain duplicates created by the bug, and because an application-level read-before-write check narrows the race window without closing it:

1. **Deploy an intermediate API that is schema-compatible both before and after the indexes exist.** Compatible is not the same as fully correct: before the indexes, its transaction and duplicate check work but concurrent duplicate enforcement is **not race-safe**; after the indexes, the database constraint closes the duplicate-identity race. Unrelated `P2002` violations fail closed in both states.
2. **That API writes in a transaction and handles only the intended event-uniqueness `P2002` constraints**, matched on model and target; any other `P2002` fails closed and surfaces as an error.
3. **Reduce duplicate creation with the application-level check**, which narrows the window but is **not race-safe on its own** and cannot be the only protection.
4. **Audit and resolve existing duplicate rows** — a data decision requiring product input, not a schema change.
5. **Prevent new duplicates while the indexes are created:** a brief ingestion pause, or an online-index / reconciliation strategy appropriate to the production database.
6. **Add and validate the uniqueness indexes.**
7. **Resume ingestion.**
8. **Enable the behaviour that relies on the indexes.**

**Backward compatibility:** the partner acknowledgement changed shape (full application view → minimal outcome). That is a breaking API change for any partner parsing the response body; it needs contract versioning and partner notification, not a silent deploy. The new `409` and `200` outcomes are also newly reachable — a partner treating any non-`2xx` as retryable would now retry `409`s forever. **This is the highest-risk part of the change from an integration standpoint.**

**Rollback:** the original API is **not** compatible with the constrained schema. It has no `P2002` handling and its writes are not transactional, so it could commit the application status update and only then hit a uniqueness violation and return `500`. A replay — especially an older one — could therefore change or rewind current state without completing the intended write set, leaving current state inconsistent with the authoritative history and notification-intent semantics. This is a worse failure than the one being fixed.

**Do not roll back to the original API while the constraints remain.** The options, in order of preference:

1. **Roll forward** with a fix.
2. **Roll back only as far as the schema-compatible intermediate version** from steps 1-2 of the migration sequence.
3. **Drop the constraints.** This explicitly reopens ING-1, the duplicate-effects P0, and is an incident decision rather than a routine rollback.

Rolling *forward* again after dropping the constraints re-enters the duplicate audit at step 4.

## 12. Deliberately postponed tradeoffs

- **Worker reliability** — one indivisible boundary (retry, lease, exhaustion, dead letter, replay); a partial fix trades silent loss for unbounded retry, which is a different failure, not a fixed one.
- **Web resilience and money formatting** — presentation of data that had to be made trustworthy first.
- **Authentication (customer and partner)** — not implemented, by the exercise's framing. Both are production blockers rather than postponed niceties; see §1 and §2.
- **Ingestion audit log** — the most valuable *additive* next step; rejected deliveries currently leave no durable trace.
