-- What every AI call used, so the spend can be seen by feature and month
-- (Admin → AI usage) instead of only on the Anthropic bill. Tokens are stored,
-- not money: the price is worked out when it is read (services/aiUsage.js),
-- so a price change never leaves wrong figures behind.
CREATE TABLE IF NOT EXISTS ai_usage (
  id            BIGSERIAL PRIMARY KEY,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  feature       TEXT NOT NULL,
  model         TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  web_searches  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_at ON ai_usage (at);
