-- Scope + optimistic version on acknowledgements (GSB-0801, migration 003)
--
-- Motivation: items that live inside a *supplemental package* (e.g. the new
-- action item ai-gd-20260729-03) must be confirmable independently of the parent
-- handoff, and confirming an action item must be checked against the version the
-- confirming client saw. Two shifts confirming the same supplemental item where
-- one carries a stale (pre-change) version must resolve to exactly one valid
-- confirmation; the stale one gets a field-level conflict and writes nothing.
--
-- Changes:
--   * supplemental_handoff_id: when set, the ack belongs to a supplemental
--     package rather than the parent handoff. Parent acks keep it NULL.
--   * acked_version: the action_item.version the confirmer acknowledged (NULL for
--     timeline events, which are immutable evidence).
--   * The uniqueness scope becomes (handoff_id, supplemental_handoff_id,
--     item_type, item_id) so a parent ack and a supplemental ack for the same
--     underlying item are independent, and each scope still allows only one ack.

BEGIN;

ALTER TABLE acknowledgements
  ADD COLUMN supplemental_handoff_id TEXT
    REFERENCES supplemental_handoffs(id) ON DELETE CASCADE,
  ADD COLUMN acked_version INTEGER;

-- Replace the old (handoff_id, item_type, item_id) unique index with a
-- scope-aware one. COALESCE keeps NULL supplemental ids distinct-safe within a
-- single btree so parent-scope acks remain unique too.
DROP INDEX IF EXISTS uq_ack_handoff_item;
CREATE UNIQUE INDEX uq_ack_scope_item
  ON acknowledgements(handoff_id, COALESCE(supplemental_handoff_id, ''), item_type, item_id);

COMMIT;
