# AI Tooling Disclosure

## Tools used

| Tool | Model | Used for |
|---|---|---|
| Claude Code (CLI, VS Code) | Claude Opus 5 | Repository exploration, reproduction scripting, adversarial review of my scope choice, test-case brainstorming, documentation drafting, diff review |
| `curl`, `sqlite3`, `pnpm` | — | Verification. Every empirical verification claim is tied to inspected code or command output. Design proposals, prioritization and assumptions are judgements, not command results. |

Claude Code was chosen because the work was repository-wide investigation under a four-hour timebox: reading twenty-odd files, reproducing defects against a running system, and drafting documentation. A tool that runs commands in the repository and shows their real output is materially better for that than a chat interface I would paste into, because the reproduction output is the evidence.

## What AI assisted with

**Defect-surface exploration.** I directed a sweep across specified lenses — authorization, idempotency, ordering, transactions, notification durability, logging, money and time. AI produced a candidate list; I discarded the speculative items and kept those I could tie to a specific line of code.

**Reproduction scripting.** AI wrote the `curl` and `sqlite3` sequences that turned suspicions into evidence: three identical POSTs producing three history rows, a late event rewinding state, `DECLINED → APPROVED` accepted. This was the highest-value assistance — the scripts are mechanical, and their output is verifiable independently of who wrote them.

**Challenging scope alternatives.** I asked for the case *against* my chosen scope. That produced the notification-reliability alternative and forced me to articulate why authorization and ingestion form one coherent boundary while a partial worker fix does not.

**Test-case brainstorming.** AI proposed a superset; I cut it to ten focused cases (T1–T10) and required table-driven invalid transitions. A later correction to the transition table added an eleventh, table-driven over every valid edge. The final suite is **23 API tests plus the repository's existing worker test — 24 total**, covering verification cases T1–T11.

**Boilerplate.** Prisma query shapes, the fixture, and the Fastify outcome mapping.

**Documentation drafting and diff review.** AI drafted these documents against my structure and reviewed the final diff.

## What remained my decision

- **Scope selection.** AI's first recommendation bundled a fifteen-minute worker patch as a stretch item. I rejected it: retry, lease, exhaustion, dead letter and replay are one reliability boundary, and a partial fix trades silent loss for unbounded retry — a different failure, not a fixed one.
- **Idempotency scope.** AI defaulted to globally unique `eventId`. I scoped uniqueness per application because `docs/DOMAIN.md` does not guarantee feed-global uniqueness. Feed-global is the **stricter** constraint: adopting it without contract evidence risks rejecting legitimate events, and moving to it later requires auditing existing cross-application collisions. Per-application uniqueness is the safer exercise default.
- **Every domain assumption** in ISSUES.md §11 — duplicate before stale before transition validation, first-accepted-wins, same-state as invalid, the acknowledgement's permitted fields.
- **Severity calibration.** I downgraded the partner-acknowledgement finding from P0 to P1 because the repository does not define the partner's permitted data scope, so "more than required" is defensible where "confirmed violation" is not.
- **What to defer**, and stating plainly that an open P0 ships unfixed.

## Suggestions I rejected or corrected

1. **The worker stretch patch** — rejected as a partial fix to an indivisible boundary.
2. **Global `eventId` uniqueness** — corrected to per-application scoping.
3. **"Reportable privacy incident"** — removed. AI asserted legal certainty the repository cannot support; replaced with "potentially serious privacy and compliance exposure."
4. **`/health` described as a domain-contract violation** — corrected. It is a valid liveness probe; the real gap is the absence of a dependency-aware readiness endpoint.
5. **"T10 exercises rollback naturally"** — rejected, then empirically disproven. See verification below.
6. **A 249-line, 24-issue register** — cut to 188 lines and 15 issues. Volume is not rigour, and the README asked for a short prioritized list.
7. **Imprecise PII wording** — corrected to distinguish that customer email is logged *directly* while partner `reason` text *may* contain sensitive data and has no redaction control. Different confidence levels deserve different words.
8. **Vague logging claims** — every location in ISSUES.md was re-derived with `cat -n` before being cited.

## How outputs were verified

**Attribution.** Claude Code executed the original repository-wide checks in my working copy at my direction; I specified what to verify and reviewed the reported output. Where this section says "I measured" or "I instrumented", it means I directed that step and reviewed its result, not that I typed the command.

I subsequently reran selected `curl` and `sqlite3` checks myself: owner versus non-owner reads, unknown-application non-disclosure, duplicate-event handling, stale and equal-timestamp rejection, invalid and terminal-transition rejection, accepted transitions, and history and notification-job row counts.

Still outstanding before submission: running the complete `pnpm check` suite personally, and a line-by-line review of the final diff. I do not claim either here.

**Every finding was reproduced or explicitly labelled otherwise.** ISSUES.md marks each item `Reproduced`, `Code inspection` or `Assumption`. The one P0 I could not reproduce (ING-3, non-atomic writes) says so and explains why.

**Three specific verification catches worth naming:**

*The lifecycle diagram.* AI read the ASCII branches by eye, so I measured the column alignment of both backslashes against the label spans programmatically. That was the right instinct applied to the wrong artifact: the measurement was accurate, but the diagram's formatting is too ambiguous to carry a product rule, and the first table it produced rejected `OFFERED -> DECLINED` — a decline after an offer, which is consistent with ordinary lending semantics. I corrected the table to permit declines from both `IN_REVIEW` and `OFFERED`, and left `SUBMITTED -> DECLINED` out as an open product question (A9). The lesson is that measuring an ambiguous source precisely does not make it authoritative.

*The rollback claim.* Rather than let T10 assert rollback coverage, I instrumented both duplicate paths with temporary probes and ran the suite: **three duplicates via the read check, zero via `P2002`.** SQLite serialized the concurrent transactions, so the rollback branch never executed. The probes were reverted; the limitation is documented in PLAN.md §2 instead of being papered over. I separately proved the constraint itself with a direct `sqlite3` insert, which failed with `UNIQUE constraint failed`.

*A false alarm I did not report as a defect.* My first post-fix reproduction returned `500` on every read. Before concluding the fix was broken, I read the error — `Environment variable not found: DATABASE_URL` — and traced it to my own invocation bypassing the root `dev` script's `cross-env`. The baseline fails identically. Wrong harness, not a code defect.

**Commands used for validation** (executed by Claude Code under my direction, output reviewed by me; the `curl` and `sqlite3` checks listed above were also rerun by me):

```
node -v && pnpm -v          # v22.18.0 / 9.15.4 (nvm use is required; system default v24 fails engine-strict)
pnpm run setup              # exit 0
pnpm lint                   # exit 0
pnpm typecheck              # exit 0 (5 projects)
pnpm test                   # exit 0, 24 tests (23 API + 1 existing worker)
pnpm build                  # exit 0
pnpm check                  # exit 0 — verified green at baseline AND after implementation
sqlite3 .../dev.db "..."    # unique index existence, row counts, state after each event
curl -s -o /dev/null -w "%{http_code}"   # every HTTP outcome in PLAN.md §1
```

## Approximate time allocation

| Phase | Time |
|---|---|
| Investigation, baseline, 15 reproductions | ~50 min |
| Risk register and two rounds of revision | ~40 min |
| Implementation | ~35 min |
| Tests and evidence | ~40 min |
| Documentation | ~40 min |
| Final verification and review | ~15 min |

## Limitations of AI-generated analysis

**It reports confidently regardless of evidence.** The first register presented code-inspection findings in the same voice as reproduced ones. The `Reproduced` / `Code inspection` / `Assumption` labels exist because of that tendency, and I applied them by checking what had actually been executed.

**It over-produces.** Left alone it generated 24 issues and 16 test cases where 15 and 10 communicate better. It optimizes for apparent thoroughness, which is the opposite of the prioritization this assessment asks for.

**It reaches for unsupported authority.** Legal characterizations, "production-ready", and the initial rollback claim were all assertions that outran the evidence.

**It reads ambiguous artifacts optimistically.** The lifecycle diagram is the clearest case: a plausible-looking reading that would have silently encoded a wrong transition table.

**It proposes architecture beyond the need.** Several suggestions — event sourcing, a separate ingestion microservice — were declined as unjustified for this timebox.

**It under-reports the limits of what it built.** A final adversarial review of the documentation surfaced two unimplemented limitations that the earlier drafts had not stated: an `eventId` reused with a different payload is absorbed as a duplicate rather than surfaced as a conflict, and the uniqueness constraints do not serialize two different event ids for the same application. Both were documented as limitations and proposed production work. Neither was fixed or tested.

## Statement

I directed the investigation, selected and constrained the scope, decided every domain assumption, set the verification plan, and read the diff and the output of every command reported here.

To be precise about what that does and does not mean: the commands were executed by Claude Code in my repository under my direction, not typed by me. I have not yet independently re-run the verification suite or completed a line-by-line manual review of the final diff; I will do both before submitting and will not claim them until then.

What I do claim: every decision recorded in these documents is mine, I can explain and defend each one — including the deliberate choice to ship with NOTIF-1 open — and I can state accurately what the tests prove and what they do not.
