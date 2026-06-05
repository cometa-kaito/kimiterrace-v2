-- #567: F13 presence の冪等 dedup を DB レベルで直列化する部分 UNIQUE index。
-- recordPresenceEvent の ON CONFLICT DO NOTHING の競合キー。並行再送（TOCTOU）の二重計上を封鎖する。
-- 前提: 既存 events に同一 (school_id, payload->>'device_mac', occurred_at) の presence 重複行が無いこと
--       （prod は cutover 前で presence データ無し・CI は fresh schema。万一 staging で衝突したら、
--        重複の最小 id を残して dedup してから再 apply する）。適用は Rule 8 のゲート経由。
CREATE UNIQUE INDEX "ux_events_presence_dedup" ON "events" USING btree ("school_id",("payload" ->> 'device_mac'),"occurred_at") WHERE "events"."type" = 'presence';