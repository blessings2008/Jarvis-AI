# JARVIS Cognitive Redesign

This branch changes JARVIS from a command-first assistant into a persistent agent architecture.

## Principles

1. The model owns interpretation, planning and decisions.
2. Code exposes capabilities; it should not contain a giant map of possible user intents.
3. Unknown requests are treated as reasoning problems before they are treated as missing features.
4. Memory stores facts, episodes, preferences and learned procedures.
5. A persistent self-model tracks identity, state, capabilities, limitations, goals and confidence.
6. Every action produces an observation that returns to the cognitive loop.
7. Learning is based on outcomes rather than merely counting unsupported requests.
8. Permissions constrain authority to act, not the ability to think about an action.
9. The Android app is the body: it advertises capabilities and executes approved dispatches.

## Cognitive loop

`PERCEIVE -> RECALL -> UNDERSTAND -> PLAN -> DECIDE -> ACT -> OBSERVE -> EVALUATE -> LEARN -> UPDATE SELF -> CONTINUE`

## Components

- `src/cognitive/cortex.js`: executive reasoning loop.
- `src/cognitive/memory.js`: layered persistent memory interface.
- `src/cognitive/self-model.js`: persistent self representation.
- `src/cognitive/tool-registry.js`: runtime capability registry.
- `src/cognitive/schema.sql`: Supabase tables for memory, self-model and experiences.
- `src/server-v2.js`: new API entrypoint.

## Android contract

The Android client should POST its current capabilities to `/api/capabilities`. A capability contains `name`, `description`, `parameters`, and `risk`. The backend can then reason over the manifest and return tool intents. The client remains responsible for device-level authority and execution.

## What is deliberately not claimed

This architecture provides a self-model and learning loop. It does not claim that JARVIS is conscious or literally self-aware. Consciousness is a scientific question; the engineering target here is persistent self-representation, autonomous planning, adaptation and memory.
