import type { FastifyPluginAsync } from "fastify";
import {
  updateActionItem,
  getActionItem,
} from "../services/actionItemService.js";
import { createActionItem } from "../services/incidentService.js";
import type { ActionItemStatus } from "../types.js";

const createSchema = {
  type: "object",
  required: ["title", "responsible_party", "actor"],
  properties: {
    id: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    detail: { type: "string" },
    status: {
      type: "string",
      enum: ["open", "in_progress", "blocked", "done"],
    },
    responsible_party: { type: "string", minLength: 1 },
    occurred_at: { type: "string" },
    actor: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

const patchSchema = {
  type: "object",
  required: ["expectedVersion"],
  properties: {
    expectedVersion: { type: "integer", minimum: 1 },
    actor: { type: "string", minLength: 1 },
    patch: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1 },
        detail: { type: "string" },
        status: {
          type: "string",
          enum: ["open", "in_progress", "blocked", "done"],
        },
        responsible_party: { type: "string", minLength: 1 },
        occurred_at: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

export const actionItemRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/incidents/:id/action-items",
    { schema: { body: createSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        id?: string;
        title: string;
        detail?: string;
        status?: ActionItemStatus;
        responsible_party: string;
        occurred_at?: string;
        actor: string;
      };
      const idempotencyKey = request.headers[
        "idempotency-key"
      ] as string | undefined;
      const result = await createActionItem(
        {
          id: body.id,
          incident_id: id,
          title: body.title,
          detail: body.detail,
          status: body.status,
          responsible_party: body.responsible_party,
          occurred_at: body.occurred_at,
          actor: body.actor,
        },
        idempotencyKey
      );
      return reply.code(result.replayed ? 200 : 201).send(result);
    }
  );

  app.get("/action-items/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const item = await getActionItem(id);
    if (!item) {
      return reply.code(404).send({
        error: "not_found",
        message: `行动项 ${id} 不存在`,
      });
    }
    return reply.send(item);
  });

  app.patch(
    "/action-items/:id",
    { schema: { body: patchSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        expectedVersion: number;
        actor: string;
        patch: {
          title?: string;
          detail?: string;
          status?: ActionItemStatus;
          responsible_party?: string;
          occurred_at?: string;
        };
      };
      const actor =
        body.actor ||
        (request.headers["x-actor"] as string | undefined) ||
        "unknown";
      const result = await updateActionItem({
        id,
        expectedVersion: body.expectedVersion,
        patch: body.patch,
        actor,
      });
      return reply.send(result);
    },
  );
};
