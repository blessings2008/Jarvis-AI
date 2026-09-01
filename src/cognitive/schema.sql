create table if not exists jarvis_memory (
  id uuid primary key default gen_random_uuid(),
  session_id text not null references jarvis_sessions(session_id) on delete cascade,
  kind text not null check (kind in ('fact','episode','procedure','preference')),
  content text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists idx_jarvis_memory_session_created on jarvis_memory(session_id, created_at desc);

create table if not exists jarvis_self_model (
  session_id text primary key references jarvis_sessions(session_id) on delete cascade,
  model jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create table if not exists jarvis_experiences (
  id uuid primary key default gen_random_uuid(),
  session_id text not null references jarvis_sessions(session_id) on delete cascade,
  goal text not null,
  plan jsonb not null default '[]',
  observations jsonb not null default '[]',
  outcome text,
  lesson text,
  created_at timestamptz not null default now()
);
create index if not exists idx_jarvis_experiences_session_created on jarvis_experiences(session_id, created_at desc);

create table if not exists jarvis_procedures (
  id uuid primary key default gen_random_uuid(),
  session_id text not null references jarvis_sessions(session_id) on delete cascade,
  name text not null,
  goal text not null,
  steps jsonb not null default '[]',
  confidence numeric not null default 0.6,
  success_count integer not null default 0,
  failure_count integer not null default 0,
  status text not null default 'active' check (status in ('active','retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(session_id, name)
);
create index if not exists idx_jarvis_procedures_session_status on jarvis_procedures(session_id, status, confidence desc);

create table if not exists jarvis_capabilities (
  id uuid primary key default gen_random_uuid(),
  session_id text not null references jarvis_sessions(session_id) on delete cascade,
  name text not null,
  description text not null default '',
  parameters jsonb not null default '{}',
  risk text not null default 'unknown',
  source text not null default 'device',
  version integer not null default 1,
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  unique(session_id, name)
);
create index if not exists idx_jarvis_capabilities_session_enabled on jarvis_capabilities(session_id, enabled);

create table if not exists jarvis_world_state (
  session_id text primary key references jarvis_sessions(session_id) on delete cascade,
  state jsonb not null default '{"devices":[],"apps":[],"services":[],"resources":[],"environment":{}}',
  updated_at timestamptz not null default now()
);
