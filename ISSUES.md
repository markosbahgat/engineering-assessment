# Engineering Risk Register

**Scope:** entire repository at commit `c902ee6` (API, worker, web, contracts, database, CI).
**Baseline:** Node v22.18.0 (`.nvmrc` = 22; `engine-strict=true` rejects the system default v24.6.0), pnpm 9.15.4. `pnpm check` passes at baseline.
**Status labels:** `Reproduced` (executed against a running system on seeded synthetic data), `Code inspection` (read, not executed), `Assumption` (needs product confirmation). No real customer data was used.

## 1. Executive Summary

The repository's verification gate is green — `pnpm check` passes (lint, typecheck, 4 tests, build). That is the most important fact here: **every defect below ships today with no signal.**

Five release-blocking risks, four of them reproduced:

1. **Ownership is never checked.** The `x-customer-id` header is caller-controlled and is treated as identity without verification, so any caller reads any customer's application and contact details.
2. **Partner events are not deduplicated.** One event replayed three times produced three history rows and three customer notifications.
3. **Ordering and lifecycle rules are unenforced.** A late event rewinds current state; `DECLINED` moved to `APPROVED`; `IN_REVIEW` jumped to `DISBURSED`.
4. **State, history and notification intent are written non-atomically**, so a mid-request failure can leave status changed with no audit trail and no notification.
5. **Failed notifications are silently discarded** and never retried.

Risks 2–4 corrupt an audit history the business is expected to trust; risk 1 is a potentially serious privacy and compliance exposure; risk 5 silently drops customer communications.

**Selected slice:** customer authorization plus trustworthy partner status ingestion (§6). Notification reliability is deferred (§9) and **remains an unmitigated release blocker.**

## 2. Current Release Assessment

**Recommendation: do not release.** Five P0s are open. Fixing the selected slice does not make the system production-ready — it makes **one boundary** (what a customer is shown, and what may change it) trustworthy and provable. NOTIF-1 must be fixed before production regardless of this slice.

## 3. Prioritization Method

- **P0** — privacy exposure, corruption of trustworthy state or audit history, duplicate business effects, or silent loss of critical work. Blocks release.
- **P1** — serious reliability, operational-recovery, API or customer-experience risk that does not by itself block release.

Ranking within a priority is by **blast radius × silence**: a defect that corrupts data with no operator signal outranks a louder one of similar severity. Lower-value findings are listed as observations in §12 rather than tracked as issues.

## 4. Prioritized Risk Register

| ID | Pri | Category | Status | Location | Impact | Treatment |
|---|---|---|---|---|---|---|
| AUTHZ-1 | P0 | Authorization / privacy | Reproduced | `apps/api/src/app.ts:27-41` | Any caller reads any application and its PII; existence is also enumerable | Implement now |
| ING-1 | P0 | Event idempotency | Reproduced | `apps/api/src/application-service.ts:68-90`; `schema.prisma:38-67` | One event replayed N times causes N history rows and N customer emails | Implement now |
| ING-2 | P0 | Ordering / state machine | Reproduced | `apps/api/src/application-service.ts:60-66`; `packages/contracts/src/index.ts:3-12` | Late events rewind state; terminal states escape; illegal skips accepted | Implement now |
| ING-3 | P0 | Transaction boundary | Code inspection | `apps/api/src/application-service.ts:60-90` | Mid-request failure leaves status changed with no history and no notification | Implement now |
| NOTIF-1 | P0 | Notification durability | Reproduced | `apps/worker/src/process-notifications.ts:61-70` | Failed notifications are marked processed and lost silently | Production design only |
| API-1 | P1 | Data minimization | Reproduced | `apps/api/src/app.ts:67` | Partner acknowledgement returns the full customer record and history | Implement now |
| API-2 | P1 | API semantics | Reproduced | `apps/api/src/app.ts:61-73` | Duplicate, stale and invalid deliveries all return `202`; partners cannot react | Implement now |
| ING-4 | P1 | Deterministic history | Code inspection | `apps/api/src/application-service.ts:20` | Ordered by `occurredAt` only; equal timestamps order arbitrarily | Implement now |
| NOTIF-2 | P1 | Worker reliability | Reproduced | `apps/worker/src/process-notifications.ts:15-73`; `apps/worker/src/index.ts:9-27` | No claim/lease (two workers deliver the same job twice); no attempt cap, exhaustion state, dead-letter surface or replay; idempotency key is `sourceEventId` alone, which does not identify the logical notification; a batch throw exits the process and `shutdown()` neither drains nor exits | Production design only |
| PII-2 | P1 | Logging / PII | Code inspection | `apps/worker/src/notification-provider.ts:21-23`; `apps/api/src/app.ts:56-59` | Customer email is written directly to stdout; partner `reason` free text may carry personal or sensitive data and has no redaction control | Production design only |
| OPS-2 | P1 | Migrations | Code inspection | `package.json` (`db:reset` uses `prisma db push --accept-data-loss`) | No migration history; no reviewable or rollbackable schema change path | Production design only |
| DOM-1 | P1 | Domain correctness | Reproduced | `apps/api/src/app.ts:48-54` | Future-dated events accepted; once ordering is enforced they become a poison pill | Defer |
| WEB-1 | P1 | Web resilience | Reproduced (dev mode) | `apps/web/src/api.ts:15` | A `404` or unreachable API produces an HTTP 500 with raw error text; production output differs but there is still no not-found or degraded state | Defer |
| WEB-2 | P1 | Money handling | Reproduced | `apps/web/app/applications/[applicationId]/page.tsx:9` | `maximumFractionDigits: 0` rounds amounts to whole units, so a displayed loan amount can be wrong | Defer |
| TEST-1 | P1 | Test quality | Code inspection | `apps/api/src/__tests__/`; `apps/worker/src/__tests__/` | 4 tests, none covering authorization, duplication, ordering or transitions; the gate cannot detect any P0 above | Implement now (slice-scoped) |

## 5. Detailed P0 Findings

Register rows above give location and impact; this section adds evidence, failure scenario and acceptance criteria.

### AUTHZ-1 — Ownership is not enforced; existence is enumerable
- **Evidence:** the header is checked for presence only (`typeof customerId !== "string" || customerId.length === 0`), then discarded; `getApplication` filters by `id` alone (`application-service.ts:16-17`). A request with `x-customer-id: attacker-supplied-value` returned `200` with `{"id":"cus_amina_001","name":"Amina Hassan","email":"amina.hassan@example.test","phone":"+201000000001"}`. Reproduced end-to-end: the portal renders another customer's record. Separately, `app_auto_002` read as `cus_amina_001` returned `200` while `app_zzz` returned `404` — the two outcomes differ, so existence is observable.
- **Failure scenario:** application ids look sequential (`app_home_001`, `app_auto_002`). Any party reaching the API iterates ids with an arbitrary header value and harvests the customer base. Returning `403` for a real-but-foreign id would still confirm which ids exist.
- **Blast radius:** every customer, every application, all contact data, plus existence metadata.
- **Acceptance criteria:** owner receives `200`; non-owner receives `404`; ownership is enforced in the database query, not by post-filtering; the non-owner response is identical in status and body to the unknown-application response.

### ING-1 — One event produces N business effects
- **Evidence:** three identical POSTs of `eventId: dup-evt-1` all returned `202`; `ApplicationStatusHistory` held 3 rows and `NotificationJob` held 3 rows. `sourceEventId` is indexed (`schema.prisma:49,66`) but not unique — `pragma_index_list` shows the only unique indexes are primary-key autoindexes.
- **Failure scenario:** partner delivery times out after our commit and is retried; the customer receives the same "your loan was declined" email three times. At-least-once delivery is normal partner behaviour, so this fires in routine operation.
- **Blast radius:** every application receiving retried deliveries; permanent history corruption.
- **Acceptance criteria:** N identical deliveries produce exactly one history row and at most one notification job, enforced by a database unique constraint rather than a read-before-write check; the repeat returns `200` with an explicit duplicate outcome.

### ING-2 — Stale events rewind state; lifecycle rules are unenforced
- **Evidence:** `OFFERED @ 10:00` followed by a late `IN_REVIEW @ 09:30` left the application at `IN_REVIEW`. `lastEventOccurredAt` is written (`application-service.ts:64`) and never read anywhere in the repository. `DECLINED` then `APPROVED` was accepted (`202`); `IN_REVIEW` to `DISBURSED` skipping two states was accepted; a second `DISBURSED` with a new `eventId` appended a fourth history row. No transition model exists — statuses are a flat enum.
- **Failure scenario:** a partner retries an older event after a network partition and a customer who was told they had an offer sees the application back under review; or a misrouted event moves a declined application to approved and downstream decisions are made against a state the business never reached.
- **Blast radius:** every application whose events arrive out of order or out of sequence; the audit history stops being usable as evidence.
- **Acceptance criteria:** an event older than the newest accepted event returns `409` and mutates nothing; equal timestamps resolve first-accepted-wins; transitions are validated against an explicit table in the shared contracts boundary; illegal transitions return `409` and mutate nothing; terminal states accept no further transitions.

### ING-3 — State, history and notification intent are not written atomically
- **Evidence:** three sequential `await`s with no `$transaction`. `docs/DOMAIN.md` describes these as one logical change.
- **Failure scenario:** the API is redeployed mid-request; status shows `APPROVED`, the newest history row still says `IN_REVIEW`, no email is sent, and nothing detects the divergence.
- **Blast radius:** low frequency, high severity, silent — found only by manual reconciliation.
- **Acceptance criteria:** all three writes occur in one transaction; a failure inside the transaction leaves zero rows changed.
- **Limitation:** not reproduced. Injecting a crash between statements would require fault-injection code in the production path, which is out of scope; the absence of a transaction is unambiguous in the source.

### NOTIF-1 — Failed notifications are silently discarded
- **Evidence:** the `finally` block sets `processedAt: new Date()` on every job including failures. The seeded `omar@retry.invalid` job after a worker run: `attemptCount=1`, `processedAt` set, `nextAttemptAt=NULL`, `lastError='mock provider is temporarily unavailable'`. Running the worker for 5s at a 500ms poll interval produced exactly one attempt. The `nextAttemptAt` query support at lines 22-25 is dead code — nothing ever sets it.
- **Failure scenario:** the email provider is degraded for 30 seconds; every status notification in that window is discarded and no operator learns of it.
- **Blast radius:** all notifications during any provider degradation; unbounded and undetectable.
- **Acceptance criteria:** a failed delivery stays unprocessed with a scheduled retry; attempts are capped; exhausted jobs reach an inspectable dead-letter state with an operator replay path.
- **Treatment:** production design only — see §9.

## 6. Selected Vertical Slice

> **Protect the trustworthiness of the customer-visible application boundary: only the owning customer can read an application, and only unique, ordered, valid partner events can change its state, history and notification intent.**

**In scope:** AUTHZ-1, ING-1, ING-2, ING-3, ING-4, API-1, API-2, and slice-scoped tests (TEST-1).

**Coherence.** Authorization is technically adjacent to event ingestion rather than part of it — the two sit on opposite sides of the system. They are taken together because they protect one asset: **what a customer is shown must be both theirs and true.** AUTHZ-1 breaks "theirs"; ING-1 to ING-3 break "true". Both are enforced at the same seam (route → typed service outcome → database constraint) and proved by the same test harness. Authorization is also the cheapest P0 in the register; excluding a reproduced privacy exposure to preserve conceptual purity would be poor judgement.

**Out of scope:** notification delivery (§9); web resilience and money formatting — presentation of data that is not yet trustworthy, which is the wrong order to fix; migrations and CORS, which are infrastructure decisions rather than correctness of this boundary.

**Not claimed:** this does not make the system production-ready.

## 7. Behavioral Invariants

Defined before implementation. The verifying test is named in §10.

| # | Invariant | Test |
|---|---|---|
| I1 | A customer can never retrieve another customer's application | T1 |
| I2 | An inaccessible application and a nonexistent one are indistinguishable | T1 |
| I3 | One logical partner event has at most one accepted domain effect | T4 |
| I4 | Current state is the newest accepted valid event, not the last request received | T5, T6 |
| I5 | Only allowed lifecycle transitions may change state | T7 (rejected), T11 (accepted) |
| I6 | Terminal states remain terminal | T7 |
| I7 | An accepted transition updates state, history and notification intent atomically | T3; T10 gives rollback evidence only if the conflict path is reached |
| I8 | Customer-visible history contains only accepted business transitions | T5, T7 |
| I9 | A partner acknowledgement exposes no customer PII | T2 |
| I10 | Duplicate, stale, invalid, malformed, unknown and accepted requests are operationally distinguishable | T1, T4, T5, T7, T8 |
| I11 | History ordering is deterministic | T9 |

**Language discipline.** This slice delivers **idempotent event ingestion** and **durable notification intent**. It does **not** deliver exactly-once notification delivery. Delivery remains at-least-once at best, and today is worse (NOTIF-1). Provider idempotency keys, bounded retries, dead-letter handling and operator replay are described in `DESIGN.md` as production work, not implemented here.

## 8. Considered Alternatives

| Alternative | Why not selected |
|---|---|
| Notification reliability (retry, lease, dead-letter, replay) | A genuine P0 and a coherent slice, but needs a schema change, lease columns, backoff, an exhaustion state and a replay surface — roughly the whole remaining budget. Taking it would leave ingestion half-finished; two half-slices is the worst outcome. |
| Customer authorization alone | Roughly 30 minutes of work; leaves three P0 data-corruption defects untouched. Under-uses the timebox. |
| End-to-end customer-visible state | Spreads across all three boundaries and produces shallow work in each. |
| Web resilience and error handling | Improves presentation of data that is still untrustworthy and still exposed to the wrong caller. Truth first, presentation second. |
| Ingestion without authorization | Would knowingly ship a reproduced privacy exposure. Not defensible. |

## 9. Explicitly Deferred Work

**NOTIF-1 is a P0 that this submission does not fix, and it is not mitigated by the selected slice.** Fixing ING-1 and ING-2 reduces the number of *duplicate and invalid* notification intents created, but it does nothing for the failure that matters: a legitimate notification whose delivery fails is still marked processed and lost. **NOTIF-1 remains an unmitigated release blocker and must be fixed before production.**

It is deferred rather than partially patched because retry scheduling, worker claim/lease, attempt exhaustion, dead-letter inspection and operator replay form **one coherent reliability boundary**. Correcting only the `finally` block would replace silent loss with unbounded retry against a provider with no attempt cap, no dead-letter state and no lease, and NOTIF-2 would still double-send under concurrency — a different failure, not a fixed one. `DESIGN.md` documents the complete target design.

Also deferred: DOM-1, WEB-1, WEB-2 (defer); NOTIF-2, PII-2, OPS-2 (production design only).

## 10. Verification Plan

**Gate:** `pnpm check` (lint, typecheck, test, build), confirmed green at baseline before any change.

| # | Test | Proves |
|---|---|---|
| T1 | Owner `200`; non-owner and unknown application return identical status and body | I1, I2, I10 |
| T2 | Partner acknowledgement body contains only `outcome`, `eventId`, `applicationId` — no name, email, phone or history | I9 |
| T3 | Valid transition: `202`, and state, history row and notification job all present | I7 |
| T4 | Duplicate delivery: `200` duplicate outcome, exactly 1 history row, 1 notification job, state applied once | I3, I10 |
| T5 | Stale event: `409`, `status` and `lastEventOccurredAt` unchanged, no history row | I4, I8, I10 |
| T6 | Equal `occurredAt`: first accepted wins, second returns `409` | I4 |
| T7 | Table-driven invalid transitions — skip-ahead, backward, out of terminal, same-state with a new `eventId`: each `409` with no mutation | I5, I6, I8, I10 |
| T8 | Malformed body returns `400`, distinguishable from `409` domain conflicts | I10 |
| T9 | History ordering is stable across repeated reads for equal `occurredAt` | I11 |
| T10 | Concurrent duplicate deliveries produce one accepted domain effect and one duplicate outcome; database assertions verify one history row, one notification intent and one final state | I3, I10 |
| T11 | Table-driven valid transitions — every edge of the lifecycle table, including declines from `IN_REVIEW` and from `OFFERED`: each `202` with state, history and notification intent advanced | I5, I7 |

Assertions are made against database rows, not only HTTP responses.

**T10 does not by itself claim transaction rollback.** If the losing transaction reaches a later unique-constraint conflict, the test also provides rollback evidence; otherwise rollback verification remains a documented limitation. No fault-injection hooks are added to the production path, and no unstable concurrency test is introduced merely to claim coverage. If SQLite concurrency makes T10 nondeterministic, the database uniqueness constraint is retained, deterministic sequential idempotency is proved instead, and concurrency verification against a production-grade database is recorded as a next step in `PLAN.md`.

**Manual evidence:** the Phase 1 reproduction commands are re-run after implementation, with before-and-after output recorded in `PLAN.md`.

## 11. Assumptions and Product Questions

Exercise assumptions, each requiring confirmation in the production partner contract.

| ID | Question | Decision | Consequence if wrong |
|---|---|---|---|
| A1 | Is `eventId` unique per partner feed or per application? | **Per application** — the domain does not guarantee feed-global uniqueness. Uniqueness scoped as history `(applicationId, sourceEventId)` and notification intent `(applicationId, sourceEventId, type)`. | If ids are feed-global, a cross-application replay would be accepted twice — detectable. Tightening to a global constraint later is the **risky** direction: existing cross-application `sourceEventId` collisions are legal under this scope and must all be audited and resolved before the narrower index can be built. |
| A2 | Are stale events rejected, audited separately, or added to customer-visible history? | Rejected `409`, no mutation, not added to customer-visible history. | Late deliveries leave no record. A separate ingestion audit log is proposed in `DESIGN.md`. |
| A3 | How are equal `occurredAt` timestamps resolved? | First accepted wins. | Deterministic without partner sequence numbers; a monotonic sequence number in the contract would be strictly better. |
| A4 | Is a same-state event with a different `eventId` invalid or a valid reaffirmation? | **Invalid — `409`. This is an assumption**, based on the documented lifecycle containing no self-loop. | If the partner legitimately reaffirms state, valid events are rejected. Visible immediately as `409`s, not silent. |
| A5 | What should duplicate delivery return? | `200` with an explicit duplicate outcome. | Distinguishes "already applied" from "newly accepted" (`202`) so the partner can stop retrying. |
| A6 | Does every accepted transition require a customer notification? | Yes — one notification intent per accepted transition. | If some transitions are internal-only, customers receive more email than intended. |
| A7 | What may the partner acknowledgement disclose? | `outcome`, `eventId`, `applicationId` only. The repository does not define the partner's permitted data scope; the current response discloses substantially more than the endpoint requires and should be minimized unless the contract explicitly requires more. | If the partner needs resulting status for reconciliation it can be added deliberately; PII cannot. |
| A8 | How should future-dated events be treated? | **Unresolved** — not addressed in this slice (DOM-1). | Once ordering is enforced, an event dated 2099 is a poison pill: no legitimate event could advance the application again. Required product decision before production. |
| A9 | Is `SUBMITTED -> DECLINED` a legal transition? | **Unresolved.** The diagram's branch arrows are ambiguous in formatting and `docs/DOMAIN.md` gives no unambiguous evidence for a decline straight from `SUBMITTED`, so it is **not** in the table and returns `409`. Declines from `IN_REVIEW` and `OFFERED` are both permitted, as the business reading requires. | If the business declines applications before review begins, those events are rejected. Loud rather than silent, and a one-line change to the transition table. Requires product confirmation. |

**Ordering of ingestion checks** (applied consistently): **duplicate detection precedes staleness, which precedes transition validation.** A replay of an already-accepted event is reported as a duplicate rather than as stale or invalid, so partner retries get a stable, accurate answer.

## 12. Additional Observations

Real but lower-value; not tracked as issues. Carried into `PLAN.md`.

- **Web identity is a hardcoded env constant** (`apps/web/src/api.ts:4`) rather than a session — exercise scaffolding, but it means the portal cannot express a real authenticated user.
- **`formatDate` pins no `timeZone`** (`apps/web/app/applications/[applicationId]/page.tsx:13-18`), so server and browser can render different timestamps.
- **No dependency-aware readiness endpoint.** `/health` (`apps/api/src/app.ts:22`) is a valid liveness probe; there is no readiness signal that checks the database.
- **`cors: { origin: true }`** (`apps/api/src/app.ts:20`) reflects any origin — acceptable locally, not for production.
- **Per-job application query in the worker** (`process-notifications.ts:37-40`) and a redundant re-read after write (`application-service.ts:92`).
