import type { FastifyPluginAsync } from "fastify";
import {
  createAcknowledgement,
  createSupplementalAcknowledgement,
} from "../services/handoffService.js";
import type { ItemType } from "../types.js";

const createSchema = {
  type: "object",
  required: ["item_type", "item_id", "acknowledged_by"],
  properties: {
    item_type: { type: "string", enum: ["action_item", "timeline_event"] },
    item_id: { type: "string", minLength: 1 },
    acknowledged_by: { type: "string", minLength: 1 },
    note: { type: "string" },
  },
  additionalProperties: false,
} as const;

const supplementalCreateSchema = {
  type: "object",
  required: ["item_type", "item_id", "acknowledged_by"],
  properties: {
    item_type: { type: "string", enum: ["action_item", "timeline_event"] },
    item_id: { type: "string", minLength: 1 },
    acknowledged_by: { type: "string", minLength: 1 },
    note: { type: "string" },
    expected_version: { type: "integer", minimum: 1 },
  },
  additionalProperties: false,
} as const;

export const acknowledgementRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/handoffs/:id/acknowledgements",
    { schema: { body: createSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        item_type: ItemType;
        item_id: string;
        acknowledged_by: string;
        note?: string;
      };
      const idempotencyKey = request.headers[
        "idempotency-key"
      ] as string | undefined;
      const { acknowledgement, replayed } = await createAcknowledgement(
        {
          handoff_id: id,
          item_type: body.item_type,
          item_id: body.item_id,
          acknowledged_by: body.acknowledged_by,
          note: body.note,
        },
        idempotencyKey
      );
      return reply.code(replayed ? 200 : 201).send({
        acknowledgement,
        replayed,
      });
    }
  );

  app.post(
    "/supplemental-handoffs/:id/acknowledgements",
    { schema: { body: supplementalCreateSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        item_type: ItemType;
        item_id: string;
        acknowledged_by: string;
        note?: string;
        expected_version?: number;
      };
      const idempotencyKey = request.headers[
        "idempotency-key"
      ] as string | undefined;
      const { acknowledgement, replayed } =
        await createSupplementalAcknowledgement(
          {
            supplemental_handoff_id: id,
            item_type: body.item_type,
            item_id: body.item_id,
            acknowledged_by: body.acknowledged_by,
            note: body.note,
            expected_version: body.expected_version,
          },
          idempotencyKey
        );
      return reply.code(replayed ? 200 : 201).send({
        acknowledgement,
        replayed,
      });
    }
  );
};
