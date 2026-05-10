CREATE TYPE org_role AS ENUM ('owner', 'admin', 'developer', 'operator', 'viewer');
CREATE TYPE bee_status AS ENUM ('online', 'degraded', 'offline', 'revoked');
CREATE TYPE job_status AS ENUM ('created', 'queued', 'assigned', 'accepted_by_bee', 'running', 'waiting_for_approval', 'succeeded', 'failed', 'cancelled', 'timed_out');
CREATE TYPE job_event_level AS ENUM ('debug', 'info', 'warn', 'error');
CREATE TYPE job_event_actor AS ENUM ('user', 'bee', 'hive', 'system');
CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'denied', 'expired');
CREATE TYPE approval_risk AS ENUM ('read', 'write', 'destructive', 'external', 'credentialed');

CREATE TABLE organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_memberships (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role org_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE bees (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  public_key text NOT NULL,
  status bee_status NOT NULL DEFAULT 'offline',
  hive_url text,
  daemon_version text,
  labels jsonb NOT NULL DEFAULT '{}',
  capabilities jsonb NOT NULL DEFAULT '{}',
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bees_org_status_idx ON bees (organization_id, status);
CREATE INDEX bees_org_name_idx ON bees (organization_id, name);

CREATE TABLE bee_sessions (
  id text PRIMARY KEY,
  bee_id text NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bee_sessions_bee_idx ON bee_sessions (bee_id);

CREATE TABLE bootstrap_tokens (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  bee_name text,
  profile_id text,
  labels jsonb NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by_bee_id text REFERENCES bees(id) ON DELETE SET NULL,
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bootstrap_tokens_org_idx ON bootstrap_tokens (organization_id);

CREATE TABLE jobs (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bee_id text REFERENCES bees(id) ON DELETE SET NULL,
  requested_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  type text NOT NULL,
  status job_status NOT NULL DEFAULT 'created',
  payload jsonb NOT NULL DEFAULT '{}',
  output jsonb,
  error jsonb,
  timeout_seconds integer,
  queued_at timestamptz,
  assigned_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_org_status_idx ON jobs (organization_id, status);
CREATE INDEX jobs_bee_status_idx ON jobs (bee_id, status);

CREATE TABLE job_events (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  bee_id text REFERENCES bees(id) ON DELETE SET NULL,
  sequence integer NOT NULL,
  type text NOT NULL,
  level job_event_level NOT NULL,
  actor job_event_actor NOT NULL,
  actor_id text,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, sequence)
);
CREATE INDEX job_events_job_idx ON job_events (job_id);

CREATE TABLE approvals (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  bee_id text REFERENCES bees(id) ON DELETE SET NULL,
  status approval_status NOT NULL DEFAULT 'pending',
  risk approval_risk NOT NULL,
  action text NOT NULL,
  summary text NOT NULL,
  input jsonb NOT NULL DEFAULT '{}',
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  resolved_at timestamptz,
  resolved_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  decision text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approvals_org_status_idx ON approvals (organization_id, status);
CREATE INDEX approvals_job_idx ON approvals (job_id);

CREATE TABLE artifacts (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  bee_id text REFERENCES bees(id) ON DELETE SET NULL,
  name text NOT NULL,
  content_type text,
  size_bytes integer,
  sha256 text,
  storage_url text,
  local_path text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artifacts_job_idx ON artifacts (job_id);

CREATE TABLE audit_logs (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_type text NOT NULL,
  actor_id text,
  action text NOT NULL,
  resource_type text,
  resource_id text,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_created_idx ON audit_logs (organization_id, created_at);

CREATE TABLE hive_settings (
  organization_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  hive_url text,
  tailscale_recommended boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
