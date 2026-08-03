import type { FastifyPluginAsync } from "fastify";
import { createTimelineEvent } from "../services/incidentService.js";

const createSchema = {
  type: "object",
  required: ["kind", "description", "responsible_party", "actor"],
  properties: {
    id: { type: "string", minLength: 1 },
    kind: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    responsible_party: { type: "string", minLength: 1 },
    evidence_uri: { type: "string" },
    occurred_at: { type: "string" },
    actor: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

export const timelineRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/incidents/:id/timeline",
    { schema: { body: createSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        id?: string;
        kind: string;
        description: string;
        responsible_party: string;
        evidence_uri?: string;
        occurred_at?: string;
        actor: string;
      };
      const idempotencyKey = request.headers[
        "idempotency-key"
      ] as string | undefined;
      const event = await createTimelineEvent(
        {
          id: body.id,
          incident_id: id,
          kind: body.kind,
          description: body.description,
          responsible_party: body.responsible_party,
          evidence_uri: body.evidence_uri,
          occurred_at: body.occurred_at,
          actor: body.actor,
        },
        idempotencyKey
      );
      return reply.code(201).send(event);
    }
  );
};
