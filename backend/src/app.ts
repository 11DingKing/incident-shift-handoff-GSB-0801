import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import {
  OptimisticLockError,
  NotFoundError,
  ValidationError,
  ImmutableResourceError,
} from "./types.js";
import { incidentRoutes } from "./routes/incidents.js";
import { actionItemRoutes } from "./routes/actionItems.js";
import { timelineRoutes } from "./routes/timeline.js";
import { handoffRoutes } from "./routes/handoffs.js";
import { acknowledgementRoutes } from "./routes/acknowledgements.js";
import { eventRoutes } from "./routes/events.js";

export function buildApp() {
  const app = Fastify({
    logger: { level: config.logLevel },
  });

  app.register(cors, {
    origin: config.corsOrigin,
    exposedHeaders: ["Idempotency-Key"],
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof OptimisticLockError) {
      reply.code(409).send({
        error: "optimistic_lock_conflict",
        message: err.message,
        currentVersion: err.currentVersion,
        conflicts: err.conflicts,
        current: err.current,
      });
      return;
    }
    if (err instanceof NotFoundError) {
      reply.code(404).send({ error: "not_found", message: err.message });
      return;
    }
    if (err instanceof ValidationError) {
      reply.code(400).send({ error: "validation_error", message: err.message });
      return;
    }
    if (err instanceof ImmutableResourceError) {
      reply.code(409).send({
        error: "immutable_resource",
        message: err.message,
      });
      return;
    }
    request.log.error(err);
    const message = err instanceof Error ? err.message : String(err);
    reply.code(500).send({ error: "internal_error", message });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.register(incidentRoutes, { prefix: "/api" });
  app.register(actionItemRoutes, { prefix: "/api" });
  app.register(timelineRoutes, { prefix: "/api" });
  app.register(handoffRoutes, { prefix: "/api" });
  app.register(acknowledgementRoutes, { prefix: "/api" });
  app.register(eventRoutes, { prefix: "/api" });

  return app;
}
