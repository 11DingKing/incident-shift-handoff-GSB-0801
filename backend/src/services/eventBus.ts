import { EventEmitter } from "node:events";

export interface IncidentChangeEvent {
  type:
    | "action_item.updated"
    | "timeline.created"
    | "handoff.created"
    | "handoff.signed"
    | "acknowledgement.created"
    | "supplemental_event.created"
    | "supplemental_handoff.created"
    | "supplemental_acknowledgement.created";
  incident_id: string;
  payload: Record<string, unknown>;
}

class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  private channel(incidentId: string): string {
    return `incident:${incidentId}`;
  }

  publish(event: IncidentChangeEvent): void {
    this.emitter.emit(this.channel(event.incident_id), event);
  }

  subscribe(
    incidentId: string,
    listener: (event: IncidentChangeEvent) => void
  ): () => void {
    const ch = this.channel(incidentId);
    this.emitter.on(ch, listener);
    return () => this.emitter.off(ch, listener);
  }
}

export const eventBus = new EventBus();
