-- Bright Legal conveyancing estimates
-- Apply with:
--   npx wrangler d1 execute bright-estimates --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS estimates (
  id                TEXT PRIMARY KEY,          -- BL-260916-4417
  created_at        TEXT NOT NULL,             -- ISO 8601, UTC
  mode              TEXT NOT NULL,             -- 'public' | 'internal'
  matter_type       TEXT NOT NULL,             -- Sale | Transfer of Equity | Assent

  -- client
  first_name        TEXT,
  last_name         TEXT,
  other_names       TEXT,
  email             TEXT,
  phone             TEXT,
  clients           INTEGER,

  -- property
  property_address  TEXT,
  price             REAL,
  tenure            TEXT,
  mortgaged         TEXT,
  debt              REAL,
  payout            REAL,
  higher_rate_sdlt  INTEGER,                   -- 0 | 1

  -- answers and the priced schedule, both JSON
  answers           TEXT,
  lines             TEXT,

  -- totals
  net               REAL NOT NULL,
  vat               REAL NOT NULL,
  total             REAL NOT NULL,

  -- internal build only
  matter_ref        TEXT,
  fee_earner        TEXT,
  scale_fee         REAL,                      -- what the rate card would have charged
  override_fee      REAL,
  override_reason   TEXT,

  -- operational
  country           TEXT,                      -- from Cloudflare, not the full IP
  emailed_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_estimates_created ON estimates (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_estimates_email   ON estimates (email);
CREATE INDEX IF NOT EXISTS idx_estimates_ref     ON estimates (matter_ref);
CREATE INDEX IF NOT EXISTS idx_estimates_earner  ON estimates (fee_earner);
