import { randomUUID } from "node:crypto";
import {
  canTransition,
  type ApplicationStatus,
  type ApplicationView,
  type StatusEventInput,
} from "@assessment/contracts";
import type { PrismaClient } from "@assessment/database";

const NOTIFICATION_TYPE = "APPLICATION_STATUS_CHANGED";

export type StatusEventOutcome =
  | { kind: "accepted"; status: ApplicationStatus }
  | { kind: "duplicate" }
  | { kind: "stale" }
  | { kind: "invalid_transition"; from: ApplicationStatus; to: ApplicationStatus }
  | { kind: "unknown_application" };

const EVENT_UNIQUENESS_CONSTRAINTS: ReadonlyArray<{
  model: string;
  target: readonly string[];
}> = [
  { model: "ApplicationStatusHistory", target: ["applicationId", "sourceEventId"] },
  { model: "NotificationJob", target: ["applicationId", "sourceEventId", "type"] },
];

function isEventUniquenessViolation(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    (error as { code?: unknown }).code !== "P2002"
  ) {
    return false;
  }

  const meta = (error as { meta?: { modelName?: unknown; target?: unknown } })
    .meta;
  const target = meta?.target;

  if (!Array.isArray(target)) return false;

  return EVENT_UNIQUENESS_CONSTRAINTS.some(
    (constraint) =>
      constraint.model === meta?.modelName &&
      constraint.target.length === target.length &&
      constraint.target.every((field, index) => target[index] === field),
  );
}

export async function getApplication(
  database: PrismaClient,
  applicationId: string,
  customerId: string,
): Promise<ApplicationView | null> {
  const application = await database.loanApplication.findFirst({
    where: { id: applicationId, customerId },
    include: {
      customer: true,
      history: {
        orderBy: [
          { occurredAt: "desc" },
          { recordedAt: "desc" },
          { id: "desc" },
        ],
      },
    },
  });

  if (!application) return null;

  return {
    id: application.id,
    status: application.status as ApplicationStatus,
    requestedAmountCents: application.requestedAmountCents,
    currency: application.currency,
    createdAt: application.createdAt.toISOString(),
    updatedAt: application.updatedAt.toISOString(),
    customer: {
      id: application.customer.id,
      name: application.customer.name,
      email: application.customer.email,
      phone: application.customer.phone,
    },
    history: application.history.map((entry) => ({
      id: entry.id,
      status: entry.status as ApplicationStatus,
      reason: entry.reason,
      occurredAt: entry.occurredAt.toISOString(),
      recordedAt: entry.recordedAt.toISOString(),
    })),
  };
}

export async function recordStatusEvent(
  database: PrismaClient,
  applicationId: string,
  event: StatusEventInput,
): Promise<StatusEventOutcome> {
  const occurredAt = new Date(event.occurredAt);

  try {
    return await database.$transaction(async (tx) => {
      const application = await tx.loanApplication.findUnique({
        where: { id: applicationId },
      });

      if (!application) return { kind: "unknown_application" };

      const alreadyRecorded = await tx.applicationStatusHistory.findFirst({
        where: { applicationId, sourceEventId: event.eventId },
        select: { id: true },
      });

      if (alreadyRecorded) return { kind: "duplicate" };

      if (
        application.lastEventOccurredAt &&
        occurredAt <= application.lastEventOccurredAt
      ) {
        return { kind: "stale" };
      }

      const from = application.status as ApplicationStatus;
      const to = event.status;

      if (!canTransition(from, to)) {
        return { kind: "invalid_transition", from, to };
      }

      await tx.loanApplication.update({
        where: { id: applicationId },
        data: { status: to, lastEventOccurredAt: occurredAt },
      });

      await tx.applicationStatusHistory.create({
        data: {
          id: randomUUID(),
          applicationId,
          status: to,
          reason: event.reason,
          sourceEventId: event.eventId,
          occurredAt,
        },
      });

      await tx.notificationJob.create({
        data: {
          id: randomUUID(),
          applicationId,
          sourceEventId: event.eventId,
          type: NOTIFICATION_TYPE,
          payload: JSON.stringify({
            status: to,
            reason: event.reason ?? null,
          }),
        },
      });

      return { kind: "accepted", status: to };
    });
  } catch (error) {
    if (isEventUniquenessViolation(error)) return { kind: "duplicate" };
    throw error;
  }
}
