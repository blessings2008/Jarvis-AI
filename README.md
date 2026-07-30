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

## What changed vs. v0.6

- Every route that touched `session.*` is now `async` and reads/writes Supabase instead of a `Map`.
- Automations moved to their own table (`jarvis_automations`) instead of a JSON array inside the session row — makes `/api/trigger` a direct indexed lookup.
- Server restarts no longer lose any state — sessions, memory, skills, modes, and automations all survive.
- Database errors are now distinguished from AI/Groq errors in logs and responses (`"JARVIS had a database error..."` vs. the existing AI-service error messages).
- Everything else (action tiers, confirmation flow, modes/styles, proactive nudges, vision, capability registry) is unchanged from v0.6.
