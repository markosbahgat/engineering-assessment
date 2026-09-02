# Plan: Delivered Scope, Limitations and Next Steps

## 1. Implemented scope

**Selected slice:** protect the trustworthiness of the customer-visible application boundary — within the exercise identity model, an application is readable only under its owning customer identity, and only unique, ordered, valid partner events can change its state, history and notification intent. The identity remains caller-supplied; ownership enforcement and authentication are separate controls and only the former is implemented.

| Issue | Change | Files |
|---|---|---|
| AUTHZ-1 | Reads scoped to the owning customer in the query; non-owner and unknown return an identical `404` | `apps/api/src/application-service.ts`, `apps/api/src/app.ts` |
| ING-1 | Database uniqueness per application for history and notification intent; narrow `P2002` mapping for the two known constraints | `packages/database/prisma/schema.prisma`, `apps/api/src/application-service.ts` |
| ING-2 | `lastEventOccurredAt` is read; stale and equal-timestamp events rejected; explicit transition table with terminal states | `packages/contracts/src/index.ts`, `apps/api/src/application-service.ts` |
| ING-3 | State, history and notification intent written in one `$transaction` | `apps/api/src/application-service.ts` |
| ING-4 | Deterministic history ordering (`occurredAt`, `recordedAt`, `id`) | `apps/api/src/application-service.ts` |
| API-1 | Acknowledgement reduced to `outcome`, `eventId`, `applicationId` | `apps/api/src/app.ts` |
| API-2 | Distinct outcomes: `202` accepted, `200` duplicate, `409` stale/invalid, `404` unknown, `400` malformed | `apps/api/src/app.ts` |
| TEST-1 | T1–T11 asserting against database rows | `apps/api/src/__tests__/app.test.ts` |

**Deliberately unchanged:** the entire worker, the entire web application, `seed.ts`, CI, and lint/TypeScript configuration.

### Evidence

Baseline `pnpm check` passed with **4 tests**. After implementation the same gate passed with **24 tests total: 23 API tests and the repository's existing worker test**.

Manual API evidence, before and after, on seeded synthetic data:

| Behaviour | Before | After |
|---|---|---|
| Arbitrary incorrect customer identity reads another customer | `200` + name, email, phone | `404 {"error":"application not found"}` |
| Non-owner customer identity reads another customer | `200` + full record | `404`, byte-identical to unknown application |
| Owner reads own application | `200` | `200` |
| Same `eventId` delivered 3× | 3× `202`; 3 history rows, 3 jobs | `202`, `200 duplicate`, `200 duplicate`; 1 history row, 1 job |
| Late event (09:30 after 11:00) | State rewound | `409 stale`, no mutation |
| Equal timestamp | Accepted, state overwritten | `409 stale`, no mutation |
| `OFFERED → DISBURSED` (skip) | `202` accepted | `409 invalid_transition`, no mutation |
| `OFFERED → IN_REVIEW` (backward) | `202` accepted | `409 invalid_transition`, no mutation |
| `DECLINED → APPROVED` (terminal) | `202` accepted | `409 invalid_transition`, no mutation |
| `IN_REVIEW → DECLINED` (valid) | `202`, no rule existed | `202` accepted; state, history and intent advanced |
| `OFFERED → DECLINED` (valid) | `202`, no rule existed | `202` accepted; state, history and intent advanced |
| `SUBMITTED → DECLINED` (A9, unresolved) | `202` accepted | `409 invalid_transition`, no mutation |
| Same-state with new `eventId` | `202`, extra history row | `409 invalid_transition`, no mutation |
| Unknown application | `404` | `404 unknown_application` |
| Malformed body | `400` | `400` with field errors, no `outcome` key |
| Partner acknowledgement body | Full customer record + history | `{outcome, eventId, applicationId}` |

## 2. Known limitations

Stated plainly rather than hedged.

1. **NOTIF-1 is an open P0 and is not mitigated by this work.** A failed notification is still marked processed and lost silently. Fewer bad jobs are created, but no legitimate lost notification is recovered. **This blocks production on its own.**
2. **Transaction rollback is not directly proven.** T10 asserts one domain effect under concurrent duplicate delivery, and the database constraint is proven to reject duplicates (`UNIQUE constraint failed: ApplicationStatusHistory.applicationId, ApplicationStatusHistory.sourceEventId`). But instrumenting the two duplicate paths showed **3 duplicates via the read check and 0 via `P2002`** — SQLite serialized the concurrent transactions, so the rollback branch was not exercised. No fault-injection hook was added to the production path to manufacture coverage. Concurrency verification against a production-grade database is a next step.
3. **`SUBMITTED → DECLINED` is rejected.** Declines are permitted from `IN_REVIEW` and `OFFERED`. A decline before review begins has no unambiguous support in `docs/DOMAIN.md`, so it is left out of the table pending product confirmation (A9) rather than guessed at.
4. **Timestamp ordering is only as trustworthy as the partner's clock.** No sequence number exists in the contract.
5. **Future-dated events are still accepted** (DOM-1) and are now more dangerous: one event dated 2099 would freeze an application permanently.
6. **The acknowledgement shape is a breaking change** for any partner parsing the response body.
7. **The unique constraints have no migration file** — applied via `prisma db push` against a fresh database.
8. **`x-customer-id` is still caller-controlled — ownership is enforced, identity is not authenticated.** These are two different controls; only ownership is implemented. The partner endpoint likewise has no authenticated identity or replay protection. **Both are production blockers** (see §3).
9. **Concurrent events with different event IDs are not serialized.** The uniqueness constraints protect event identity, not application state: two concurrent deliveries with different `eventId` values can both read the same state, both pass validation, and both write. The service has no compare-and-set version check. SQLite serialized these writes in the exercise environment, which is a property of that database and not evidence the production race is closed. Production needs optimistic concurrency with bounded retry, or per-application serialization in the ingestion layer.
10. **An `eventId` reused with a different payload is reported as a duplicate, not a conflict.** Duplicate detection matches `(applicationId, sourceEventId)` and returns before comparing status, `occurredAt` or `reason`, so conflicting content is silently discarded. This holds only if the partner guarantees one event id permanently identifies one immutable payload — which the repository does not state. Production should persist a canonical fingerprint of the immutable event fields and distinguish `duplicate` from `event_id_conflict`.

## 3. Next steps, in priority order

**Immediate (blocks production)**

1. **Fix worker reliability as one unit** (NOTIF-1, NOTIF-2): stop marking failures processed; capped exponential backoff with jitter; conditional-update claim/lease; attempt cap with a `DEAD_LETTER` state; operator inspect-and-replay. Idempotency key = `applicationId + sourceEventId + notificationType`.
2. **Customer authentication** (WEB-3): replace the caller-controlled `x-customer-id` header with a verified session or token, derive the customer identity from authenticated claims, and keep the ownership predicate in the database query. Ownership enforcement alone does not authenticate the caller.
3. **Partner authentication**: an authenticated integration (mTLS or signed requests) with timestamp/nonce or equivalent replay protection, and the accepted partner identity bound to the integration and application scope it may write.
4. **Resolve DOM-1** (future-dated events) before the ordering guard reaches production.
5. **Confirm assumptions A1, A4 and A9** with the partner contract — event-id uniqueness scope, same-state semantics, and whether an application may be declined directly from `SUBMITTED`.
6. **Version the partner acknowledgement** and notify integrators before deploying the shape change.
7. **Resolve concurrency between different event ids** (limitation 9). Before production, either prove and enforce per-application serialization in the upstream/ingestion architecture, or implement application-level optimistic concurrency using a `version` compare-and-set with bounded retry. Optimistic concurrency is the preferred proposal; per-application serialization is the alternative. SQLite's behaviour in the exercise environment is not evidence for production.

**Short term**

8. Ingestion audit log for rejected deliveries — currently they leave no durable trace.
9. Event fingerprint and an `event_id_conflict` outcome, so a reused event id with different content is surfaced rather than absorbed as a duplicate (limitation 10). Required before production unless the partner contract confirms event-id immutability and that assumption is monitored.
10. Log redaction (PII-2): email out of provider logs, partner `reason` treated as unredactable.
11. Web resilience (WEB-1): not-found and degraded states instead of a 500.
12. Money formatting (WEB-2): stop rounding minor units away.

**Medium term**

13. `prisma migrate` with checked-in migrations (OPS-2).
14. Readiness endpoint separate from liveness; correlation ids; the metrics and alerts in `DESIGN.md` §10.
15. A partner sequence number for ordering, replacing reliance on partner timestamps.
16. Move the outbox to a managed broker; retire the polling worker.

## 4. Migration sequence for the uniqueness constraints

Against a live database that may already contain duplicates. An application-level read-before-write check narrows the race window but is **not** race-safe on its own, so it cannot be the only protection while the index is built.

1. Deploy an **intermediate API compatible with the schema both before and after the indexes exist**.
2. That API writes in a **transaction** and narrowly handles **only the intended event-uniqueness `P2002` constraints**, matched on model and target; any other `P2002` fails closed and surfaces as an error.
3. Reduce duplicate creation with the application-level check — it narrows the window and is **not race-safe by itself**.
4. Audit and resolve existing duplicate `(applicationId, sourceEventId)` rows — a data decision requiring product input.
5. Prevent new duplicates while the indexes are created: a brief ingestion pause, or an online-index / reconciliation strategy appropriate to the production database.
6. Add and validate the uniqueness indexes.
7. Resume ingestion.
8. Enable the behaviour that relies on those indexes.

## 5. Testing expansion

Current: 23 focused API tests plus the original worker test, asserting against database rows. Both the valid and invalid transition suites are table-driven over the lifecycle table.

Next, in order:
1. Worker reliability tests once NOTIF-1 is fixed — retry scheduling, lease contention between two consumers, exhaustion, replay.
2. Concurrency tests against PostgreSQL to exercise the rollback path SQLite serializes away (limitation 2).
3. Property-based testing over event sequences, asserting properties that actually hold:
   - duplicate deliveries never add domain effects;
   - stale events never change current state;
   - every adjacent pair in accepted history is a legal transition;
   - application status equals the newest accepted history status;
   - inserting duplicate deliveries into an ordered valid sequence does not change the final state.

   **Convergence under arbitrary permutation is not a property of this system and must not be asserted.** A newer event that arrives before its missing prerequisite is rejected as an invalid transition and is never reconsidered when the prerequisite arrives — nothing buffers or replays it. Closing that gap is production work: partner sequence numbers, gap detection, quarantine or buffering of early-arriving events, and reconciliation or replay to drain the quarantine.
4. A contract test pinning the partner acknowledgement shape, so PII cannot re-enter by accident.
5. Web rendering tests for not-found, degraded and money-formatting cases.

## 6. Rollout and rollback

**Rollout:** follow §4 — the compatible API ships **before** the constraint-adding migration, never after it. The ordering guard changes which events are accepted, so watch ingestion outcomes by kind during rollout — a spike in `stale` or `invalid_transition` means the partner's real behaviour differs from `docs/DOMAIN.md`, and that is a contract conversation rather than a rollback.

**Rollback:** the original API is **not** compatible with the constrained schema. It has no `P2002` handling and its writes are not transactional, so it could commit the application status update and only then hit a uniqueness violation and return `500`. A replay — especially an older one — could therefore change or rewind current state without completing the intended write set, leaving current state inconsistent with the authoritative history and notification-intent semantics. **Do not roll back to the original API while the constraints remain.** Prefer rolling forward with a fix; if rollback is necessary, roll back only to the schema-compatible intermediate version from steps 1-2 of §4. Dropping the constraints to admit the original API explicitly reopens ING-1 and is an incident decision, not a routine rollback step.

## 7. Operational readiness checklist

- [ ] Notification retry, dead letter and replay implemented (**blocking**)
- [ ] Future-dated event policy decided (**blocking**)
- [ ] Partner contract confirms A1, A4, A9 (**blocking**)
- [ ] Acknowledgement change versioned and communicated (**blocking**)
- [ ] Customer authentication: verified session or token replacing caller-controlled `x-customer-id` (**blocking**)
- [ ] Partner authentication with replay protection and scope binding (**blocking**)
- [ ] Migration files replace `db push`
- [ ] Readiness endpoint and correlation ids
- [ ] Dead-letter depth alert
- [ ] History-vs-state divergence reconciliation
- [ ] Log redaction verified
- [ ] Concurrency between different event ids resolved: proven per-application serialization upstream, or optimistic concurrency with bounded retry (**blocking**)
- [ ] Event-id immutability confirmed in the partner contract and monitored, **or** fingerprint comparison with `event_id_conflict` implemented (**blocking**)

## 8. Product decisions still required

| Question | Needed before |
|---|---|
| Is `eventId` unique per feed or per application? (A1) | Tightening or keeping the constraint scope |
| Is `SUBMITTED → DECLINED` legal? (A9) | Any real partner traffic |
| Is a same-state event invalid or a reaffirmation? (A4) | Any real partner traffic |
| How are future-dated events handled? (A8/DOM-1) | Production ordering |
| Does every accepted transition notify the customer? (A6) | Notification volume |
| May the acknowledgement include resulting status? (A7) | Partner reconciliation needs |
| Should rejected deliveries be retained in an audit log? (A2) | Operational evidence requirements |
| Does an `eventId` permanently identify one immutable payload, and what response is required when the same id arrives with different content? | Production ingestion; today a reused id is absorbed as a duplicate |
