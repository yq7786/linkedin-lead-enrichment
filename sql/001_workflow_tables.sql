CREATE TABLE IF NOT EXISTS workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL,
  requested_limit integer,
  mode text NOT NULL,
  started_by text,
  error_summary text
);

CREATE TABLE IF NOT EXISTS linkedin_connection_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  linkedin_profile_url text,
  full_name text,
  headline text,
  current_company_name text,
  current_company_url text,
  account text,
  processing_source text,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  individual_id integer REFERENCES new_individual(id) ON DELETE SET NULL ON UPDATE CASCADE,
  company_id integer REFERENCES new_company(id) ON DELETE SET NULL ON UPDATE CASCADE,
  dedupe_status text NOT NULL DEFAULT 'dedupe_pending',
  dedupe_match_method text,
  workflow_status text NOT NULL DEFAULT 'discovered',
  current_step text,
  queued_at timestamptz,
  in_progress_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  retry_count integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  last_error text
);

ALTER TABLE linkedin_connection_inventory
  ADD COLUMN IF NOT EXISTS account text;

ALTER TABLE linkedin_connection_inventory
  ADD COLUMN IF NOT EXISTS processing_source text;

CREATE UNIQUE INDEX IF NOT EXISTS linkedin_connection_inventory_profile_url_idx
  ON linkedin_connection_inventory (lower(linkedin_profile_url))
  WHERE linkedin_profile_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS linkedin_connection_inventory_dedupe_status_idx
  ON linkedin_connection_inventory (dedupe_status);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES workflow_runs(id),
  inventory_id uuid REFERENCES linkedin_connection_inventory(id),
  event_type text NOT NULL,
  status text NOT NULL,
  message text,
  metadata_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
