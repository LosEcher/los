-- 064_dsh_event_outbox.sql
-- los → DSH 事件投递的**幂等键**（P1-a，2026-10-09）。
--
-- 传输复用 execution_outbox 的持久重试机制（attempts / next_attempt_at / last_error /
-- published_at），但 DSH 事件行用独立哨兵 entity_type='dsh_event' 与消费方隔离：
--   * 会话事件发布器按 entity_type <> 'dsh_event' 认领（否则会把这些行当缺 session_event_id 的行重试到死）；
--   * DSH 转发器只认领 entity_type = 'dsh_event'。
-- 幂等：同一 eventId 只入队一次（接收端 dsh-los-ops 还会按 eventId 再去重一层）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_outbox_dsh_event_id
  ON execution_outbox (entity_id)
  WHERE entity_type = 'dsh_event';
