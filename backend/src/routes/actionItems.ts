import type { FastifyPluginAsync } from "fastify";
import {
  updateActionItem,
  getActionItem,
} from "../services/actionItemService.js";
import type { ActionItemStatus } from "../types.js";

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
    }
  );
};
