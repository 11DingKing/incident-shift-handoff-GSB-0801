import Fastify from 'fastify';
import cors from '@fastify/cors';
import { registerRoutes } from './routes.js';
import { HttpError } from './errors.js';

export async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  await registerRoutes(app);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      reply.status(err.statusCode).send(err.body);
      return;
    }
    req.log.error(err);
    reply.status(500).send({ error: 'internal_error', message: err.message });
  });

  return app;
}
