# JARVIS v0.7 — Supabase-backed

Persistence moved from an in-memory `Map` to Supabase. Two tables:

- `jarvis_sessions` — one row per `sessionId`: conversation history, long-term memory, mode/style, installed skills, device state, pending confirmation, last action result, proactive-nudge budget.
- `jarvis_automations` — one row per automation rule (`trigger` → `actions[]`), linked to a session, deleted automatically when the session is cleared.

## 1. Create the tables

In the Supabase SQL editor, run:

```sql
create table if not exists jarvis_sessions (
  session_id text primary key,
  history jsonb not null default '[]',
  long_term_memory jsonb not null default '[]',
  pending_confirmation jsonb,
  last_action_result jsonb,
  mode text not null default 'conversation',
  style text not null default 'adaptive',
  installed_skills jsonb not null default '["core"]',
  device_state jsonb,
  proactive jsonb not null default '{"date": null, "count": 0}',
  updated_at timestamptz not null default now()
);

create table if not exists jarvis_automations (
  id uuid primary key default gen_random_uuid(),
  session_id text not null references jarvis_sessions(session_id) on delete cascade,
  trigger text not null,
  actions jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_jarvis_automations_session_trigger
  on jarvis_automations (session_id, trigger);
```

Row Level Security (RLS) can stay **enabled** on both tables with no policies — this backend connects using the **service role key**, which bypasses RLS entirely. That's expected and safe *as long as the service role key never leaves this server* (never bundle it into the Android app).

## 2. Get your keys

In Supabase: **Project Settings → API**
- `Project URL` → `SUPABASE_URL`
- `service_role` secret key → `SUPABASE_SERVICE_ROLE_KEY` (NOT the `anon` key)

## 3. Install & configure

```bash
npm install
```

`.env`:
```
GROQ_API_KEY=your_groq_key
GROQ_MODEL=llama-3.1-8b-instant
GROQ_VISION_MODEL=your_vision_capable_model   # optional, check Groq console for current availability
PORT=3000
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

```bash
npm start
```

`GET /api/health` now also reports `"database": "connected"` or `"unreachable"` so you can quickly confirm the Supabase connection is working.

## Migration for v0.7.1 (permission status)

If you already created the tables from v0.7, run this one line to add the new column — no data is lost:

```sql
alter table jarvis_sessions
  add column if not exists granted_permissions jsonb not null default '[]';
```

If you're setting up fresh, the `create table` statement above already needs this column — see the updated schema:

```sql
create table if not exists jarvis_sessions (
  session_id text primary key,
  history jsonb not null default '[]',
  long_term_memory jsonb not null default '[]',
  pending_confirmation jsonb,
  last_action_result jsonb,
  mode text not null default 'conversation',
  style text not null default 'adaptive',
  installed_skills jsonb not null default '["core"]',
  granted_permissions jsonb not null default '[]',
  device_state jsonb,
  proactive jsonb not null default '{"date": null, "count": 0}',
  updated_at timestamptz not null default now()
);
```

## Migration for v0.8 (self-evolution + web search)

Three new tables, plus one new env var. Run in the Supabase SQL editor:

```sql
create table if not exists jarvis_capability_gaps (
  id uuid primary key default gen_random_uuid(),
  session_id text not null references jarvis_sessions(session_id) on delete cascade,
  requested_text text not null,
  occurrences integer not null default 1,
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (session_id, requested_text)
);

create table if not exists jarvis_suggestions (
  id uuid primary key default gen_random_uuid(),
  session_id text not null references jarvis_sessions(session_id) on delete cascade,
  gap_id uuid references jarvis_capability_gaps(id) on delete set null,
  title text not null,
  description text,
  suggested_action jsonb,
  status text not null default 'pending_review', -- pending_review | approved | rejected
  created_at timestamptz not null default now()
);

create table if not exists jarvis_action_log (
  id uuid primary key default gen_random_uuid(),
  session_id text not null references jarvis_sessions(session_id) on delete cascade,
  action text not null,
  status text not null, -- 'requested' | 'success' | 'failure'
  created_at timestamptz not null default now()
);

create index if not exists idx_jarvis_action_log_session_action on jarvis_action_log (session_id, action, status);
```

Add to `.env` / Render environment variables:
```
TAVILY_API_KEY=your_tavily_key   # optional — sign up at tavily.com; without it, web search is silently disabled
```

**What this enables:**
- `GET /api/gaps?sessionId=` — everything JARVIS has been asked for that it can't do yet, sorted by how often
- `GET /api/suggestions?sessionId=&status=pending_review` — JARVIS's self-drafted feature proposals (never auto-applied — you review and manually implement)
- `POST /api/suggestions/:id/status` — `{ sessionId, status: "approved" | "rejected" }`
- Action reliability now feeds into the system prompt automatically — no new endpoint needed
- `/api/proactive-check` now also nudges about automating a frequently-repeated action, not just battery/late-night
- `/api/chat` responses may include a `sources` array when JARVIS used web search

## What changed vs. v0.6

- Every route that touched `session.*` is now `async` and reads/writes Supabase instead of a `Map`.
- Automations moved to their own table (`jarvis_automations`) instead of a JSON array inside the session row — makes `/api/trigger` a direct indexed lookup.
- Server restarts no longer lose any state — sessions, memory, skills, modes, and automations all survive.
- Database errors are now distinguished from AI/Groq errors in logs and responses (`"JARVIS had a database error..."` vs. the existing AI-service error messages).
- Everything else (action tiers, confirmation flow, modes/styles, proactive nudges, vision, capability registry) is unchanged from v0.6.
