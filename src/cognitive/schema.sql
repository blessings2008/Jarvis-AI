create table if not exists jarvis_memory (
  id uuid primary key default gen_random_uuid(),
  session_id text not null references jarvis_sessions(session_id) on delete cascade,
  kind text not null check (kind in ('fact','episode','procedure','preference')),
  content text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists idx_jarvis_memory_session_created
  on jarvis_memory(session_id, created_at desc);

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

create index if not exists idx_jarvis_experiences_session_created
  on jarvis_experiences(session_id, created_at desc);
