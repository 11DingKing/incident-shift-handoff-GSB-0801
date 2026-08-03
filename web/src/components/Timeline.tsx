import { fmtTime } from '../api';
import { KIND_LABEL, type TimelineEvent } from '../types';

export function Timeline({
  events,
  onOpenHandoff,
}: {
  events: TimelineEvent[];
  onOpenHandoff: (id: string) => void;
}) {
  return (
    <section aria-labelledby="timeline-heading">
      <h2 id="timeline-heading">证据时间线</h2>
      <ol className="timeline">
        {events.map((e) => (
          <li key={e.id} className={`tl-${e.kind}`} data-testid={`event-${e.id}`}>
            <div className="card-head">
              <span className={`badge kind-${e.kind}`}>{KIND_LABEL[e.kind]}</span>
              <strong>{e.title}</strong>
              <span className="mono muted">{e.id}</span>
            </div>
            {e.detail && <div>{e.detail}</div>}
            <div className="muted">
              {fmtTime(e.occurred_at)} ・ {e.owner}
              {e.handoff_id && (
                <>
                  {' '}
                  ・ 关联交接包{' '}
                  <button
                    className="link"
                    data-focus-id={`tl-open-${e.id}`}
                    onClick={() => onOpenHandoff(e.handoff_id!)}
                  >
                    {e.handoff_id}
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
