import type { FastifyPluginAsync } from "fastify";
import { getIncidentDetail, listAuditForIncident } from "../services/incidentService.js";

export const incidentRoutes: FastifyPluginAsync = async (app) => {
  app.get("/incidents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const detail = await getIncidentDetail(id);
    return reply.send(detail);
  });

  app.get("/incidents/:id/audit", async (request, reply) => {
    const { id } = request.params as { id: string };
    const limit = Number((request.query as { limit?: string }).limit ?? 200);
    const events = await listAuditForIncident(id, limit);
    return reply.send({ audit_events: events });
  });
};
