import { randomBytes } from "node:crypto";

function compactId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

export const ids = {
  handoff: () => compactId("ho"),
  acknowledgement: () => compactId("ack"),
  supplementalHandoff: () => compactId("sh"),
  supplementalEvent: () => compactId("se"),
  timelineEvent: () => compactId("tl"),
  audit: () => compactId("au"),
};
