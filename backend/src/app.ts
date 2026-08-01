import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { HttpError, ValidationError } from './errors.js';
import * as svc from './service.js';

/** CORS without an extra dependency (the frontend runs on a different port). */
function registerCors(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
      reply.header('access-control-allow-methods', 'GET,POST,PATCH,OPTIONS');
      reply.header('access-control-allow-headers', 'content-type');
    }
    if (req.method === 'OPTIONS') {
      reply.code(204).send();
    }
  });
}

function requireString(obj: Record<string, unknown>, field: string): string {
  const v = obj[field];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ValidationError(`missing or invalid field: ${field}`);
  }
  return v;
}

function requireNumber(obj: Record<string, unknown>, field: string): number {
  const v = obj[field];
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new ValidationError(`missing or invalid integer field: ${field}`);
  }
  return v;
}

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  registerCors(app);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      reply.code(err.statusCode).send(err.body ?? { error: err.message });
      return;
    }
    app.log.error(err);
    reply.code(500).send({ error: 'internal_error', message: err.message });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  // Test-only reset endpoint: truncates all data and re-seeds the canonical
  // incident. Guarded so it can never be exposed in a real deployment.
  if (process.env.ALLOW_TEST_RESET === '1') {
    app.post('/api/test/reset', async () => {
      await svc.resetForTests();
      return { status: 'reset' };
    });
  }

  // Full incident aggregate for the main view.
  app.get('/api/incidents/:id', async (req) => {
    const { id } = req.params as { id: string };
    return svc.getIncidentBundle(id);
  });

  // Append a timeline / evidence event.
  app.post('/api/incidents/:id/timeline', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const event = await svc.addTimelineEvent(id, {
      id: body.id as string | undefined,
      kind: requireString(body, 'kind'),
      description: requireString(body, 'description'),
      responsible_party: requireString(body, 'responsible_party'),
      evidence_uri: (body.evidence_uri as string | undefined) ?? null,
      occurred_at: requireString(body, 'occurred_at'),
      actor: requireString(body, 'actor'),
    });
    reply.code(201);
    return event;
  });

  // Create a new action item (e.g. a post-sign-off follow-up).
  app.post('/api/incidents/:id/action-items', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const item = await svc.createActionItem(id, {
      id: body.id as string | undefined,
      title: requireString(body, 'title'),
      detail: body.detail as string | undefined,
      status: body.status as svc.CreateActionItemInput['status'],
      responsible_party: requireString(body, 'responsible_party'),
      occurred_at: requireString(body, 'occurred_at'),
      actor: requireString(body, 'actor'),
    });
    reply.code(201);
    return item;
  });

  // Optimistic-locked action item update.
  app.patch('/api/incidents/:id/action-items/:itemId', async (req) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    return svc.updateActionItem(id, itemId, {
      expectedVersion: requireNumber(body, 'expected_version'),
      status: body.status as svc.UpdateActionItemInput['status'],
      title: body.title as string | undefined,
      detail: body.detail as string | undefined,
      responsible_party: body.responsible_party as string | undefined,
      actor: requireString(body, 'actor'),
    });
  });

  // Create a draft handoff.
  app.post('/api/incidents/:id/handoffs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const handoff = await svc.createHandoff(id, {
      from_shift: requireString(body, 'from_shift'),
      to_shift: requireString(body, 'to_shift'),
      summary: requireString(body, 'summary'),
      created_by: requireString(body, 'created_by'),
    });
    reply.code(201);
    return handoff;
  });

  app.get('/api/handoffs/:handoffId', async (req) => {
    const { handoffId } = req.params as { handoffId: string };
    const handoff = await svc.getHandoff(handoffId);
    const [acknowledgements, supplemental_events, supplemental_handoff] = await Promise.all([
      svc.listAcknowledgements(handoffId),
      svc.listSupplementalEvents(handoffId),
      svc.getSupplementalHandoffByParent(handoffId),
    ]);
    return { ...handoff, acknowledgements, supplemental_events, supplemental_handoff };
  });

  // Sign off a handoff (atomic snapshot + audit); idempotent via header/body key.
  app.post('/api/incidents/:id/handoffs/:handoffId/sign-off', async (req) => {
    const { id, handoffId } = req.params as { id: string; handoffId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const idempotencyKey =
      (req.headers['idempotency-key'] as string | undefined) ??
      (body.idempotency_key as string | undefined);
    return svc.signOffHandoff(id, handoffId, {
      signed_off_by: requireString(body, 'signed_off_by'),
      expectedVersion: requireNumber(body, 'expected_version'),
      idempotencyKey,
      actor: requireString(body, 'signed_off_by'),
    });
  });

  // Per-item acknowledgement (idempotent).
  app.post('/api/handoffs/:handoffId/acknowledgements', async (req, reply) => {
    const { handoffId } = req.params as { handoffId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const idempotencyKey =
      (req.headers['idempotency-key'] as string | undefined) ??
      (body.idempotency_key as string | undefined);
    const itemType = requireString(body, 'item_type');
    if (itemType !== 'action_item' && itemType !== 'timeline_event') {
      throw new ValidationError('item_type must be action_item or timeline_event');
    }
    const { acknowledgement, duplicate } = await svc.acknowledgeItem(handoffId, {
      item_type: itemType,
      item_id: requireString(body, 'item_id'),
      acknowledged_by: requireString(body, 'acknowledged_by'),
      note: body.note as string | undefined,
      idempotencyKey,
    });
    reply.code(duplicate ? 200 : 201);
    return { ...acknowledgement, duplicate };
  });

  // Append a supplemental event to a signed handoff.
  app.post('/api/incidents/:id/handoffs/:handoffId/supplemental', async (req, reply) => {
    const { id, handoffId } = req.params as { id: string; handoffId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const idempotencyKey =
      (req.headers['idempotency-key'] as string | undefined) ??
      (body.idempotency_key as string | undefined);
    const event = await svc.addSupplementalEvent(id, handoffId, {
      kind: requireString(body, 'kind'),
      description: requireString(body, 'description'),
      responsible_party: requireString(body, 'responsible_party'),
      occurred_at: requireString(body, 'occurred_at'),
      actor: requireString(body, 'responsible_party'),
      idempotencyKey,
    });
    reply.code(201);
    return event;
  });

  // Create a supplemental handoff *package* (structured field-level diff vs the
  // parent's frozen snapshot). Idempotent; one package per parent handoff.
  app.post('/api/incidents/:id/handoffs/:handoffId/supplemental-handoff', async (req, reply) => {
    const { id, handoffId } = req.params as { id: string; handoffId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const idempotencyKey =
      (req.headers['idempotency-key'] as string | undefined) ??
      (body.idempotency_key as string | undefined);
    const { supplemental, duplicate } = await svc.createSupplementalHandoff(id, handoffId, {
      from_shift: requireString(body, 'from_shift'),
      to_shift: requireString(body, 'to_shift'),
      summary: body.summary as string | undefined,
      created_by: requireString(body, 'created_by'),
      idempotencyKey,
    });
    reply.code(duplicate ? 200 : 201);
    return { ...supplemental, duplicate };
  });

  return app;
}
