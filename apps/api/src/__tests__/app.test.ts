import { randomUUID } from "node:crypto";
import { prisma } from "@assessment/database";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const OWNER = "customer-a";
const OTHER = "customer-b";
const OWNED = "application-a";
const FOREIGN = "application-b";
const TERMINAL = "application-terminal";
const UNKNOWN = "application-does-not-exist";

async function seedFixture() {
  await prisma.notificationJob.deleteMany();
  await prisma.applicationStatusHistory.deleteMany();
  await prisma.loanApplication.deleteMany();
  await prisma.customer.deleteMany();

  await prisma.customer.create({
    data: {
      id: OWNER,
      name: "Test Customer",
      email: "customer@example.test",
      phone: "+201111111111",
      applications: {
        create: [
          {
            id: OWNED,
            status: "SUBMITTED",
            requestedAmountCents: 100_000_00,
            lastEventOccurredAt: new Date("2026-08-20T08:00:00.000Z"),
            history: {
              create: {
                id: randomUUID(),
                status: "SUBMITTED",
                sourceEventId: "initial-event",
                occurredAt: new Date("2026-08-20T08:00:00.000Z"),
              },
            },
          },
          {
            id: TERMINAL,
            status: "DECLINED",
            requestedAmountCents: 50_000_00,
            lastEventOccurredAt: new Date("2026-08-20T07:00:00.000Z"),
          },
        ],
      },
    },
  });

  await prisma.customer.create({
    data: {
      id: OTHER,
      name: "Other Customer",
      email: "other@example.test",
      phone: "+201222222222",
      applications: {
        create: {
          id: FOREIGN,
          status: "IN_REVIEW",
          requestedAmountCents: 90_000_00,
          lastEventOccurredAt: new Date("2026-08-19T13:00:00.000Z"),
        },
      },
    },
  });
}

function testApp() {
  return buildApp({ database: prisma, logger: false });
}

function statusEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: `evt-${randomUUID()}`,
    status: "IN_REVIEW",
    occurredAt: "2026-08-20T09:00:00.000Z",
    ...overrides,
  };
}

async function post(
  app: ReturnType<typeof testApp>,
  applicationId: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: `/v1/applications/${applicationId}/status-events`,
    payload,
  });
}

async function snapshot(applicationId: string) {
  const application = await prisma.loanApplication.findUnique({
    where: { id: applicationId },
  });
  return {
    status: application?.status,
    lastEventOccurredAt: application?.lastEventOccurredAt?.toISOString(),
    history: await prisma.applicationStatusHistory.count({
      where: { applicationId },
    }),
    jobs: await prisma.notificationJob.count({ where: { applicationId } }),
  };
}

describe("application reads: ownership and non-disclosure", () => {
  beforeEach(seedFixture);

  it("T1: owner reads; non-owner is indistinguishable from unknown", async () => {
    const app = testApp();

    const owned = await app.inject({
      method: "GET",
      url: `/v1/applications/${OWNED}`,
      headers: { "x-customer-id": OWNER },
    });
    expect(owned.statusCode).toBe(200);
    expect(owned.json()).toMatchObject({
      id: OWNED,
      customer: { id: OWNER },
    });

    const foreign = await app.inject({
      method: "GET",
      url: `/v1/applications/${FOREIGN}`,
      headers: { "x-customer-id": OWNER },
    });
    const unknown = await app.inject({
      method: "GET",
      url: `/v1/applications/${UNKNOWN}`,
      headers: { "x-customer-id": OWNER },
    });

    expect(foreign.statusCode).toBe(404);
    expect(foreign.statusCode).toBe(unknown.statusCode);
    expect(foreign.body).toBe(unknown.body);
    expect(foreign.body).not.toContain("Other Customer");
    expect(foreign.body).not.toContain("other@example.test");

    await app.close();
  });
});

describe("partner status ingestion", () => {
  beforeEach(seedFixture);

  it("T2: acknowledgement carries only outcome, eventId and applicationId", async () => {
    const app = testApp();
    const event = statusEvent();
    const response = await post(app, OWNED, event);

    expect(response.statusCode).toBe(202);
    expect(Object.keys(response.json()).sort()).toEqual([
      "applicationId",
      "eventId",
      "outcome",
    ]);
    expect(response.json()).toEqual({
      outcome: "accepted",
      eventId: event.eventId,
      applicationId: OWNED,
    });
    for (const secret of [
      "Test Customer",
      "customer@example.test",
      "+201111111111",
      "history",
      "requestedAmountCents",
    ]) {
      expect(response.body).not.toContain(secret);
    }

    await app.close();
  });

  it("T3: an accepted transition writes state, history and notification intent", async () => {
    const app = testApp();
    const event = statusEvent({ reason: "Documents received" });
    const response = await post(app, OWNED, event);

    expect(response.statusCode).toBe(202);

    const after = await snapshot(OWNED);
    expect(after.status).toBe("IN_REVIEW");
    expect(after.lastEventOccurredAt).toBe("2026-08-20T09:00:00.000Z");
    expect(after.history).toBe(2);
    expect(after.jobs).toBe(1);

    const job = await prisma.notificationJob.findFirstOrThrow({
      where: { applicationId: OWNED, sourceEventId: event.eventId },
    });
    expect(JSON.parse(job.payload)).toEqual({
      status: "IN_REVIEW",
      reason: "Documents received",
    });

    await app.close();
  });

  it.each([
    { from: "SUBMITTED", to: "IN_REVIEW" },
    { from: "IN_REVIEW", to: "OFFERED" },
    { from: "IN_REVIEW", to: "DECLINED" },
    { from: "OFFERED", to: "APPROVED" },
    { from: "OFFERED", to: "DECLINED" },
    { from: "APPROVED", to: "DISBURSED" },
  ])("T11: $from -> $to is accepted", async ({ from, to }) => {
    await prisma.loanApplication.update({
      where: { id: OWNED },
      data: { status: from },
    });

    const app = testApp();
    const before = await snapshot(OWNED);
    const response = await post(
      app,
      OWNED,
      statusEvent({ status: to, occurredAt: "2026-08-21T10:00:00.000Z" }),
    );

    expect(response.statusCode).toBe(202);

    const after = await snapshot(OWNED);
    expect(after.status).toBe(to);
    expect(after.history).toBe(before.history + 1);
    expect(after.jobs).toBe(before.jobs + 1);

    await app.close();
  });

  it("T4: duplicate delivery has exactly one domain effect", async () => {
    const app = testApp();
    const event = statusEvent();

    const first = await post(app, OWNED, event);
    expect(first.statusCode).toBe(202);
    const afterFirst = await snapshot(OWNED);

    const second = await post(app, OWNED, event);
    const third = await post(app, OWNED, event);

    expect(second.statusCode).toBe(200);
    expect(second.json().outcome).toBe("duplicate");
    expect(third.statusCode).toBe(200);

    expect(await snapshot(OWNED)).toEqual(afterFirst);
    await expect(
      prisma.applicationStatusHistory.count({
        where: { applicationId: OWNED, sourceEventId: event.eventId },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.notificationJob.count({
        where: { applicationId: OWNED, sourceEventId: event.eventId },
      }),
    ).resolves.toBe(1);

    await app.close();
  });

  it("T5: a stale event is rejected and mutates nothing", async () => {
    const app = testApp();
    expect((await post(app, OWNED, statusEvent())).statusCode).toBe(202);
    const before = await snapshot(OWNED);

    const stale = statusEvent({
      status: "OFFERED",
      occurredAt: "2026-08-20T08:30:00.000Z",
    });
    const response = await post(app, OWNED, stale);

    expect(response.statusCode).toBe(409);
    expect(response.json().outcome).toBe("stale");
    expect(await snapshot(OWNED)).toEqual(before);

    await app.close();
  });

  it("T6: equal timestamps resolve first-accepted-wins", async () => {
    const app = testApp();
    expect((await post(app, OWNED, statusEvent())).statusCode).toBe(202);
    const before = await snapshot(OWNED);

    const tie = statusEvent({
      status: "OFFERED",
      occurredAt: "2026-08-20T09:00:00.000Z",
    });
    const response = await post(app, OWNED, tie);

    expect(response.statusCode).toBe(409);
    expect(response.json().outcome).toBe("stale");
    expect(await snapshot(OWNED)).toEqual(before);

    await app.close();
  });

  it.each([
    { name: "skip ahead", target: OWNED, status: "OFFERED" },
    { name: "skip to terminal", target: OWNED, status: "DISBURSED" },
    { name: "same state", target: OWNED, status: "SUBMITTED" },
    { name: "decline before review (A9, unresolved)", target: OWNED, status: "DECLINED" },
    { name: "backward", target: FOREIGN, status: "SUBMITTED" },
    { name: "skip from review", target: FOREIGN, status: "APPROVED" },
    { name: "out of terminal", target: TERMINAL, status: "APPROVED" },
    { name: "terminal to terminal", target: TERMINAL, status: "DISBURSED" },
  ])(
    "T7: invalid transition ($name) is rejected and mutates nothing",
    async ({ target, status }) => {
      const app = testApp();
      const before = await snapshot(target);

      const response = await post(
        app,
        target,
        statusEvent({ status, occurredAt: "2026-08-21T10:00:00.000Z" }),
      );

      expect(response.statusCode).toBe(409);
      expect(response.json().outcome).toBe("invalid_transition");
      expect(await snapshot(target)).toEqual(before);

      await app.close();
    },
  );

  it("T8: malformed input is distinguishable from a domain conflict", async () => {
    const app = testApp();
    const before = await snapshot(OWNED);

    const malformed = await post(app, OWNED, {
      eventId: "",
      status: "UNKNOWN",
      occurredAt: "yesterday",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toHaveProperty("error");
    expect(malformed.json()).not.toHaveProperty("outcome");

    const conflict = await post(app, OWNED, statusEvent({ status: "OFFERED" }));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toHaveProperty("outcome");

    expect(await snapshot(OWNED)).toEqual(before);

    const unknown = await post(app, UNKNOWN, statusEvent());
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().outcome).toBe("unknown_application");

    await app.close();
  });

  it("T9: history ordering is deterministic for equal timestamps", async () => {
    const occurredAt = new Date("2026-08-20T09:00:00.000Z");
    await prisma.applicationStatusHistory.createMany({
      data: [
        {
          id: "history-tie-a",
          applicationId: OWNED,
          status: "IN_REVIEW",
          sourceEventId: "tie-a",
          occurredAt,
        },
        {
          id: "history-tie-b",
          applicationId: OWNED,
          status: "IN_REVIEW",
          sourceEventId: "tie-b",
          occurredAt,
        },
      ],
    });

    const app = testApp();
    const read = async () => {
      const response = await app.inject({
        method: "GET",
        url: `/v1/applications/${OWNED}`,
        headers: { "x-customer-id": OWNER },
      });
      return response.json().history.map((entry: { id: string }) => entry.id);
    };

    const first = await read();
    const second = await read();

    expect(first).toEqual(second);
    expect(first.slice(0, 2)).toEqual(["history-tie-b", "history-tie-a"]);

    await app.close();
  });

  it("T10: concurrent duplicate deliveries produce one domain effect", async () => {
    const app = testApp();
    const event = statusEvent();

    const responses = await Promise.all([
      post(app, OWNED, event),
      post(app, OWNED, event),
    ]);

    const outcomes = responses.map((response) => response.json().outcome).sort();
    expect(outcomes).toEqual(["accepted", "duplicate"]);

    const after = await snapshot(OWNED);
    expect(after.status).toBe("IN_REVIEW");
    expect(after.history).toBe(2);
    expect(after.jobs).toBe(1);

    await app.close();
  });
});
