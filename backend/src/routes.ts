import type { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import { query, withTransaction, pool } from './db/pool.js';
import * as repo from './repo.js';
import { ConflictError, ImmutableHandoffError, NotFoundError } from './errors.js';
import type { ActionItemStatus } from './types.js';

const ACTOR_HEADER = 'x-actor';

function actor(req: any): string {
  const raw = (req.headers[ACTOR_HEADER] as string) || 'anonymous';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ ok: true, time: new Date().toISOString() }));

  // ----- Incidents -----
  app.get('/api/incidents/:incidentId', async (req, reply) => {
    const { incidentId } = req.params as any;
    const inc = await repo.getIncident(pool, incidentId);
    return inc;
  });

  app.get('/api/incidents/:incidentId/action-items', async (req) => {
    const { incidentId } = req.params as any;
    return repo.listActionItems(pool, incidentId);
  });

  app.get('/api/incidents/:incidentId/timeline', async (req) => {
    const { incidentId } = req.params as any;
    return repo.listTimeline(pool, incidentId);
  });

  app.get('/api/incidents/:incidentId/handoffs', async (req) => {
    const { incidentId } = req.params as any;
    return repo.listHandoffs(pool, incidentId);
  });

  app.get('/api/incidents/:incidentId/audit', async (req) => {
    const { incidentId } = req.params as any;
    return repo.listAudit(pool, incidentId);
  });

  // ----- Action items (optimistic locking) -----
  app.patch('/api/action-items/:actionItemId', async (req, reply) => {
    const { actionItemId } = req.params as any;
    const body = req.body as any;
    if (typeof body.expected_version !== 'number') {
      return reply.status(400).send({ error: 'expected_version (number) is required' });
    }
    const result = await withTransaction((client) =>
      repo.updateActionItem(client, actionItemId, {
        title: body.title,
        description: body.description,
        status: body.status as ActionItemStatus,
        owner: body.owner,
        due_at: body.due_at,
        expected_version: body.expected_version,
        actor: actor(req),
      }),
    );
    return result;
  });

  app.post('/api/incidents/:incidentId/action-items', async (req) => {
    const { incidentId } = req.params as any;
    const body = req.body as any;
    return withTransaction((client) =>
      repo.addActionItem(client, incidentId, {
        title: body.title,
        description: body.description ?? '',
        status: (body.status ?? 'open') as ActionItemStatus,
        owner: body.owner,
        due_at: body.due_at ?? null,
        occurred_at: body.occurred_at ?? new Date().toISOString(),
      }),
    );
  });

  // ----- Timeline (append-only) -----
  app.post('/api/incidents/:incidentId/timeline', async (req) => {
    const { incidentId } = req.params as any;
    const body = req.body as any;
    return withTransaction((client) =>
      repo.addTimelineEvent(client, incidentId, {
        event_type: body.event_type,
        summary: body.summary,
        actor: body.actor ?? actor(req),
        occurred_at: body.occurred_at ?? new Date().toISOString(),
      } as any),
    );
  });

  // ----- Handoffs -----
  app.post('/api/incidents/:incidentId/handoffs', async (req) => {
    const { incidentId } = req.params as any;
    const body = req.body as any;
    const handoffId = body.handoff_id ?? `hnd-${uuid()}`;
    return withTransaction((client) =>
      repo.createHandoff(client, {
        handoff_id: handoffId,
        incident_id: incidentId,
        from_shift: body.from_shift,
        to_shift: body.to_shift,
        summary: body.summary ?? '',
        created_by: body.created_by ?? actor(req),
      }),
    );
  });

  app.get('/api/handoffs/:handoffId', async (req) => {
    const { handoffId } = req.params as any;
    return repo.getHandoff(pool, handoffId);
  });

  // ----- Acknowledgments (idempotent, atomic status flip) -----
  app.post('/api/handoffs/:handoffId/acknowledge', async (req) => {
    const { handoffId } = req.params as any;
    const body = req.body as any;
    if (!body.confirmed_by) {
      return { status: 400, error: 'confirmed_by is required' };
    }
    const idempotencyKey = body.idempotency_key ?? uuid();
    const result = await withTransaction((client) =>
      repo.acknowledge(client, {
        handoff_id: handoffId,
        action_item_id: body.action_item_id ?? null,
        confirmed_by: body.confirmed_by,
        note: body.note,
        idempotency_key: idempotencyKey,
      }),
    );
    return { ...result, idempotency_key: idempotencyKey };
  });

  // Convenience: per-item acknowledge
  app.post('/api/handoffs/:handoffId/items/:actionItemId/acknowledge', async (req) => {
    const { handoffId, actionItemId } = req.params as any;
    const body = req.body as any;
    if (!body.confirmed_by) {
      return { status: 400, error: 'confirmed_by is required' };
    }
    const idempotencyKey = body.idempotency_key ?? uuid();
    const result = await withTransaction((client) =>
      repo.acknowledge(client, {
        handoff_id: handoffId,
        action_item_id: actionItemId,
        confirmed_by: body.confirmed_by,
        note: body.note,
        idempotency_key: idempotencyKey,
      }),
    );
    return { ...result, idempotency_key: idempotencyKey };
  });
}
