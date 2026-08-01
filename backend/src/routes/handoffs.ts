import type { FastifyPluginAsync } from "fastify";
import {
  createHandoff,
  signHandoff,
  getHandoffDetail,
  appendSupplementalEvent,
} from "../services/handoffService.js";

const createSchema = {
  type: "object",
  required: ["from_shift", "to_shift", "summary", "created_by"],
  properties: {
    from_shift: { type: "string", minLength: 1 },
    to_shift: { type: "string", minLength: 1 },
    summary: { type: "string" },
    created_by: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

const signSchema = {
  type: "object",
  required: ["actor"],
  properties: {
    actor: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

const supplementalSchema = {
  type: "object",
  required: ["kind", "description", "responsible_party", "actor"],
  properties: {
    kind: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    responsible_party: { type: "string", minLength: 1 },
    occurred_at: { type: "string" },
    actor: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

export const handoffRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/incidents/:id/handoffs",
    { schema: { body: createSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        from_shift: string;
        to_shift: string;
        summary: string;
        created_by: string;
      };
      const idempotencyKey = request.headers[
        "idempotency-key"
      ] as string | undefined;
      const handoff = await createHandoff(
        {
          incident_id: id,
          from_shift: body.from_shift,
          to_shift: body.to_shift,
          summary: body.summary,
          created_by: body.created_by,
        },
        idempotencyKey
      );
      return reply.code(201).send(handoff);
    }
  );

  app.get("/handoffs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const detail = await getHandoffDetail(id);
    return reply.send(detail);
  });

  app.post(
    "/handoffs/:id/sign",
    { schema: { body: signSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { actor: string };
      const idempotencyKey = request.headers[
        "idempotency-key"
      ] as string | undefined;
      const handoff = await signHandoff(id, body.actor, idempotencyKey);
      return reply.send(handoff);
    }
  );

  app.post(
    "/handoffs/:id/supplemental-events",
    { schema: { body: supplementalSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        kind: string;
        description: string;
        responsible_party: string;
        occurred_at?: string;
        actor: string;
      };
      const idempotencyKey = request.headers[
        "idempotency-key"
      ] as string | undefined;
      const event = await appendSupplementalEvent(
        {
          handoff_id: id,
          kind: body.kind,
          description: body.description,
          responsible_party: body.responsible_party,
          occurred_at: body.occurred_at,
          actor: body.actor,
        },
        idempotencyKey
      );
      return reply.code(201).send(event);
    }
  );
};
