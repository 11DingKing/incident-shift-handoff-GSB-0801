import type { FastifyPluginAsync } from "fastify";
import { eventBus, type IncidentChangeEvent } from "../services/eventBus.js";

export const eventRoutes: FastifyPluginAsync = async (app) => {
  app.get("/incidents/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (event: IncidentChangeEvent) => {
      raw.write(`event: ${event.type}\n`);
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    send({
      type: "handoff.created",
      incident_id: id,
      payload: { connected: true },
    });

    const unsubscribe = eventBus.subscribe(id, send);

    const heartbeat = setInterval(() => {
      raw.write(`: ping ${Date.now()}\n\n`);
    }, 15_000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      raw.end();
    });
  });
};
