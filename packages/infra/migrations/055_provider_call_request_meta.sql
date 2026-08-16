-- 055_provider_call_request_meta.sql
-- Roadmap R2a: capture the request-side configuration snapshot (reasoning
-- effort, thinking mode, sampling scalars) on every provider call.
-- Mirrors DSH's LlmCallConfig-in-header approach so historical data can
-- attribute cost/latency/quality to the reasoning tier actually requested.
ALTER TABLE provider_call_telemetry ADD COLUMN IF NOT EXISTS request_meta_json JSONB;
