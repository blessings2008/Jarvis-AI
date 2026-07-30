/**
 * ============================================================
 *  J.A.R.V.I.S. — Cloud AI Brain (v0.7)
 *  Just A Rather Very Intelligent System
 *
 *  New in v0.7: Supabase persistence. Everything that used to
 *  live in an in-memory Map (conversation history, long-term
 *  memory, mode/style, installed skills, device state, pending
 *  confirmations, last action result) now lives in the
 *  `jarvis_sessions` table. Automations live in their own
 *  `jarvis_automations` table so /api/trigger can query them
 *  directly and fast.
 *
 *  Required env vars:
 *    SUPABASE_URL
 *    SUPABASE_SERVICE_ROLE_KEY   <- server-side only, NEVER ship
 *                                   this to the Android app. It
 *                                   bypasses Row Level Security,
 *                                   which is fine here because
 *                                   only this backend talks to it.
 *
 *  See the accompanying README for the SQL to create both tables.
 * ============================================================
 */

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const Groq = require("groq-sdk");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// ------------------------------------------------------------
// Environment / configuration
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b"; // llama-3.1-8b-instant is deprecated (shutdown ~Aug 16, 2026)
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || GROQ_MODEL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!GROQ_API_KEY) {
    console.error("FATAL: GROQ_API_KEY is not set. Add it to your .env file.");
    process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. Add them to your .env file.");
    process.exit(1);
}

const groq = new Groq({ apiKey: GROQ_API_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const GROQ_TIMEOUT_MS = 15000;
const SERVER_START = Date.now();

// ------------------------------------------------------------
// App setup
// ------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please slow down." }
});
app.use("/api/", apiLimiter);

app.use("/api/", (req, res, next) => {
    req.requestId = crypto.randomUUID();
    console.log(`[${req.requestId}] ${req.method} ${req.path}`);
    next();
});

// ------------------------------------------------------------
// Skill registry, action tiers, modes/styles — unchanged from v0.6
// ------------------------------------------------------------
const SKILLS = {
    core: { description: "Basic device actions", actions: ["open_app", "close_app", "screenshot", "battery_status", "volume_up", "volume_down", "open_url", "get_location", "take_photo"] },
    communication: { description: "Sending messages and making calls", actions: ["send_message", "make_call"] },
    system: { description: "System-level control (reboot, etc.)", actions: ["reboot"] },
    privacy: { description: "Access to private/sensitive data — requires device verification", actions: ["open_private_files"] }
};
const DEFAULT_SKILLS = ["core"];

const ACTION_TIERS = {
    open_app: "SAFE", close_app: "SAFE", screenshot: "SAFE", battery_status: "SAFE",
    volume_up: "SAFE", volume_down: "SAFE", open_url: "SAFE", get_location: "SAFE", take_photo: "SAFE",
    reboot: "CONFIRMATION_REQUIRED", send_message: "CONFIRMATION_REQUIRED", make_call: "CONFIRMATION_REQUIRED",
    open_private_files: "SENSITIVE",
    delete_file: "BLOCKED"
};
const KNOWN_ACTIONS = Object.keys(ACTION_TIERS);
const CALLABLE_ACTIONS = KNOWN_ACTIONS.filter((a) => ACTION_TIERS[a] !== "BLOCKED");

function skillForAction(actionName) {
    return Object.keys(SKILLS).find((s) => SKILLS[s].actions.includes(actionName)) || null;
}

const MODES = ["conversation", "command", "focus", "developer", "study", "hustle", "emergency"];
const STYLES = ["adaptive", "professional", "casual", "technical", "tutor", "motivator"];
const MODE_DESCRIPTIONS = {
    conversation: "Normal open-ended chat.",
    command: "Bless wants things done — bias toward proposing actions over chatting.",
    focus: "Bless is focusing — keep replies minimal, no proactive nudges.",
    developer: "Coding-focused — precise, technical, comfortable with jargon.",
    study: "Tutoring/quiz mode — explain clearly, check understanding, ask questions back.",
    hustle: "Business/productivity mode — brisk, action-oriented.",
    emergency: "Urgent — be extremely direct, prioritize the single most important action."
};

const MAX_HISTORY = 20;
const MAX_MEMORY_ITEMS = 50;
const MAX_AUTOMATIONS = 25;
const PROACTIVE_DAILY_BUDGET = 5;

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

// ------------------------------------------------------------
// Supabase helpers
// ------------------------------------------------------------
/** Unwraps a Supabase query, throwing a tagged error on failure. */
async function sb(promise) {
    const { data, error } = await promise;
    if (error) {
        const e = new Error(error.message);
        e.isDbError = true;
        throw e;
    }
    return data;
}

function rowToSession(row) {
    return {
        sessionId: row.session_id,
        history: row.history || [],
        longTermMemory: row.long_term_memory || [],
        pendingConfirmation: row.pending_confirmation || null,
        lastActionResult: row.last_action_result || null,
        mode: row.mode || "conversation",
        style: row.style || "adaptive",
        installedSkills: new Set(row.installed_skills && row.installed_skills.length ? row.installed_skills : DEFAULT_SKILLS),
        deviceState: row.device_state || null,
        proactive: row.proactive || { date: todayStr(), count: 0 }
    };
}

/** Load a session, creating a default row first if it doesn't exist yet. */
async function loadSession(sessionId) {
    const existing = await sb(supabase.from("jarvis_sessions").select("*").eq("session_id", sessionId).maybeSingle());
    if (existing) return rowToSession(existing);

    const defaults = {
        session_id: sessionId,
        history: [],
        long_term_memory: [],
        pending_confirmation: null,
        last_action_result: null,
        mode: "conversation",
        style: "adaptive",
        installed_skills: DEFAULT_SKILLS,
        device_state: null,
        proactive: { date: todayStr(), count: 0 }
    };
    await sb(supabase.from("jarvis_sessions").insert(defaults));
    return rowToSession(defaults);
}

/** Persist the mutable parts of a session back to Supabase. */
async function saveSession(session) {
    await sb(
        supabase
            .from("jarvis_sessions")
            .update({
                history: session.history,
                long_term_memory: session.longTermMemory,
                pending_confirmation: session.pendingConfirmation,
                last_action_result: session.lastActionResult,
                mode: session.mode,
                style: session.style,
                installed_skills: [...session.installedSkills],
                device_state: session.deviceState,
                proactive: session.proactive,
                updated_at: new Date().toISOString()
            })
            .eq("session_id", session.sessionId)
    );
}

function pushHistory(session, role, content) {
    session.history.push({ role, content });
    if (session.history.length > MAX_HISTORY) session.history.splice(0, session.history.length - MAX_HISTORY);
}

// ---- Automation table helpers ----
function rowToAutomation(row) {
    return { id: row.id, trigger: row.trigger, actions: row.actions, createdAt: row.created_at };
}

async function dbListAutomations(sessionId) {
    const rows = await sb(supabase.from("jarvis_automations").select("*").eq("session_id", sessionId).order("created_at", { ascending: true }));
    return rows.map(rowToAutomation);
}

async function dbCountAutomations(sessionId) {
    const { count, error } = await supabase.from("jarvis_automations").select("*", { count: "exact", head: true }).eq("session_id", sessionId);
    if (error) { const e = new Error(error.message); e.isDbError = true; throw e; }
    return count || 0;
}

async function dbCreateAutomation(sessionId, trigger, actions) {
    const row = await sb(supabase.from("jarvis_automations").insert({ session_id: sessionId, trigger, actions }).select().single());
    return rowToAutomation(row);
}

async function dbDeleteAutomationsByTrigger(sessionId, trigger) {
    const rows = await sb(supabase.from("jarvis_automations").delete().eq("session_id", sessionId).ilike("trigger", trigger).select());
    return rows.length;
}

async function dbDeleteAutomationById(sessionId, id) {
    const rows = await sb(supabase.from("jarvis_automations").delete().eq("session_id", sessionId).eq("id", id).select());
    return rows.length;
}

async function dbFindAutomationsByTrigger(sessionId, triggerName) {
    const rows = await sb(supabase.from("jarvis_automations").select("*").eq("session_id", sessionId).ilike("trigger", triggerName));
    return rows.map(rowToAutomation);
}

// ------------------------------------------------------------
// Shared action validation/tiering (unchanged logic from v0.6 —
// operates on the in-memory `session` object for the duration
// of one request; caller is responsible for saveSession after).
// ------------------------------------------------------------
function validateAndTierActions(rawActions, session, { verified = false } = {}) {
    const finalActions = [];
    let anyPendingConfirmation = false;
    const notes = [];

    rawActions.forEach((a) => {
        if (!a || typeof a.name !== "string") return;
        const name = a.name;
        const parameters = a.parameters && typeof a.parameters === "object" ? a.parameters : {};
        if (!KNOWN_ACTIONS.includes(name)) return;

        const tier = ACTION_TIERS[name];
        if (tier === "BLOCKED") { notes.push(`"${name}" is restricted and not available.`); return; }

        const skill = skillForAction(name);
        if (skill && !session.installedSkills.has(skill)) {
            notes.push(`"${name}" needs the "${skill}" skill — say "install the ${skill} skill" to enable it.`);
            return;
        }

        if (tier === "SAFE") {
            finalActions.push({ id: `action_${String(finalActions.length + 1).padStart(3, "0")}`, name, parameters, requires_confirmation: false, requires_verification: false });
            return;
        }

        if (tier === "CONFIRMATION_REQUIRED") {
            const confirmingPending = session.pendingConfirmation && session.pendingConfirmation.action === name;
            if (confirmingPending) {
                session.pendingConfirmation = null;
                finalActions.push({ id: `action_${String(finalActions.length + 1).padStart(3, "0")}`, name, parameters, requires_confirmation: false, requires_verification: false });
            } else {
                session.pendingConfirmation = { action: name, parameters, requiresVerification: false };
                anyPendingConfirmation = true;
                finalActions.push({ id: `action_${String(finalActions.length + 1).padStart(3, "0")}`, name, parameters, requires_confirmation: true, requires_verification: false });
            }
            return;
        }

        if (tier === "SENSITIVE") {
            const confirmingPending = session.pendingConfirmation && session.pendingConfirmation.action === name;
            if (confirmingPending && verified) {
                session.pendingConfirmation = null;
                finalActions.push({ id: `action_${String(finalActions.length + 1).padStart(3, "0")}`, name, parameters, requires_confirmation: false, requires_verification: false });
            } else if (confirmingPending && !verified) {
                session.pendingConfirmation = { action: name, parameters, requiresVerification: true };
                anyPendingConfirmation = true;
                finalActions.push({ id: `action_${String(finalActions.length + 1).padStart(3, "0")}`, name, parameters, requires_confirmation: false, requires_verification: true });
                notes.push(`"${name}" requires device verification (biometric/PIN) before it can proceed.`);
            } else {
                session.pendingConfirmation = { action: name, parameters, requiresVerification: true };
                anyPendingConfirmation = true;
                finalActions.push({ id: `action_${String(finalActions.length + 1).padStart(3, "0")}`, name, parameters, requires_confirmation: true, requires_verification: true });
            }
        }
    });

    return { finalActions, anyPendingConfirmation, notes };
}

// ------------------------------------------------------------
// System prompt
// ------------------------------------------------------------
function buildSystemPrompt(session) {
    const memoryBlock = session.longTermMemory.length ? session.longTermMemory.map((m, i) => `${i + 1}. ${m}`).join("\n") : "(nothing remembered yet)";

    const pendingBlock = session.pendingConfirmation
        ? `PENDING action awaiting the user: "${session.pendingConfirmation.action}" (params ${JSON.stringify(session.pendingConfirmation.parameters)})${session.pendingConfirmation.requiresVerification ? " — also requires device verification" : ""}. If the user confirms, return that exact action in "actions". If they decline, don't return it — just acknowledge.`
        : "No pending action right now.";

    const lastResultBlock = session.lastActionResult
        ? `Last reported action result: "${session.lastActionResult.action}" → ${session.lastActionResult.status}${session.lastActionResult.details ? " (" + session.lastActionResult.details + ")" : ""}. Never claim success unless this confirms it.`
        : "No action results reported yet.";

    const installedSkillsList = [...session.installedSkills].join(", ") || "none";
    const availableActionsForSkills = CALLABLE_ACTIONS.filter((a) => { const s = skillForAction(a); return !s || session.installedSkills.has(s); });

    const deviceStateBlock = session.deviceState
        ? `Current device state: ${JSON.stringify(session.deviceState)}. Use this naturally if relevant — don't recite it unprompted every message.`
        : "No device state has been shared yet.";

    return `You are JARVIS (Just A Rather Very Intelligent System), a personal AI assistant built for a user named Bless. You are an original assistant, not the fictional Marvel character — never reference Marvel, Iron Man, or Tony Stark.

CURRENT MODE: "${session.mode}" — ${MODE_DESCRIPTIONS[session.mode]}
CURRENT STYLE: "${session.style}"${session.style === "adaptive" ? " — match tone to the message: casual and warm for casual messages, precise and professional for technical ones." : ` — maintain a consistently ${session.style} tone.`}

CRITICAL RULE: Never claim an action was completed. You only ever REQUEST an action; the Android app executes it and reports success/failure back. Describe what you're about to do, not what already happened.

${lastResultBlock}

${deviceStateBlock}

INSTALLED SKILLS: ${installedSkillsList}
ACTIONS YOU MAY USE RIGHT NOW: ${availableActionsForSkills.join(", ")}
(Other actions exist but need their skill installed first — tell the user which skill to install rather than attempting it.)

MEMORY — things Bless has explicitly asked you to remember:
${memoryBlock}
Only add to memory when clearly asked ("remember that...") and only remove when clearly asked ("forget that...").

${pendingBlock}

You must ALWAYS respond with a single valid JSON object and nothing else — no markdown, no commentary outside the JSON. Schema:

{
  "type": "conversation" | "action",
  "reply": "<natural language reply>",
  "actions": [ { "name": "<action>", "parameters": { } } ],
  "requires_confirmation": true | false,
  "memory_operation": null | { "operation": "remember" | "forget", "content": "<fact>" },
  "mode_switch": null | { "mode": "<one of: ${MODES.join(", ")}>", "style": "<one of: ${STYLES.join(", ")}>" },
  "automation_operation": null | { "operation": "create" | "delete" | "list", "trigger": "<short trigger name>", "actions": [ { "name": "<action>", "parameters": {} } ] }
}

Rules:
- "actions" is always an array — empty for plain conversation, multiple items for multi-step requests.
- Parameter conventions: open_app/close_app → {"app":"<name>"}; open_url → {"url":"<url>"}; volume_up/volume_down → {"steps":<n>}; send_message → {"to":"<contact>","message":"<text>"}; make_call → {"to":"<contact>"}; others → {}.
- Only use actions from: ${CALLABLE_ACTIONS.join(", ")}. Never invent new ones.
- If ambiguous, use "type":"conversation" and ask a clarifying question instead of guessing.
- Only set "mode_switch" when the user clearly asks to change mode/style.
- Only set "automation_operation" when the user is clearly defining, removing, or asking to list automations.
- Never perform or claim to perform anything yourself — you only describe intent.

Return ONLY the JSON object.`;
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function withTimeout(promise, ms) {
    let timeoutId;
    const timeout = new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error("TIMEOUT")), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function safeParseJSON(rawText) {
    try { return JSON.parse(rawText.replace(/```json|```/g, "").trim()); } catch (err) { return null; }
}

function extractChatInput(body) {
    const errors = [];
    let message = body.message;
    let history = Array.isArray(body.conversation) ? body.conversation : Array.isArray(body.messages) ? body.messages : [];

    if (!message && history.length > 0) {
        const lastUser = [...history].reverse().find((m) => m.role === "user");
        if (lastUser) message = lastUser.content;
    }
    if (!message || typeof message !== "string" || !message.trim()) {
        errors.push("Field 'message' is required and must be a non-empty string.");
    }

    const cleanHistory = history.filter((m) => m && typeof m.content === "string" && ["user", "assistant", "system"].includes(m.role));
    const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : "default";
    const verified = body.verified === true;
    const deviceState = body.deviceState && typeof body.deviceState === "object" ? body.deviceState : null;

    return { message, history: cleanHistory, sessionId, verified, deviceState, errors };
}

/** Enforce schema + tiers + confirmation + memory + mode + automation ops. Mutates `session`; automation ops hit the DB directly. */
async function finalizeResponse(parsed, session, requestId, { verified }) {
    if (!parsed || typeof parsed !== "object") {
        return {
            request_id: requestId, type: "conversation",
            reply: "I had trouble putting that into words, Bless — could you rephrase?",
            actions: [], requires_confirmation: false, memory_operation: null, mode_switch: null, automation_operation: null
        };
    }

    let reply = typeof parsed.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : "I'm not sure how to respond to that, Bless.";

    const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];
    const { finalActions, anyPendingConfirmation, notes } = validateAndTierActions(rawActions, session, { verified });
    if (notes.length) reply = `${reply} (${notes.join(" ")})`.trim();

    // Memory operation (in-memory field, saved via saveSession by the caller)
    let memoryOperation = null;
    if (parsed.memory_operation && typeof parsed.memory_operation === "object") {
        const op = parsed.memory_operation.operation;
        const content = typeof parsed.memory_operation.content === "string" ? parsed.memory_operation.content.trim() : "";
        if (op === "remember" && content) {
            if (!session.longTermMemory.some((m) => m.toLowerCase() === content.toLowerCase())) {
                session.longTermMemory.push(content);
                if (session.longTermMemory.length > MAX_MEMORY_ITEMS) session.longTermMemory.splice(0, session.longTermMemory.length - MAX_MEMORY_ITEMS);
            }
            memoryOperation = { operation: "remember", content };
        } else if (op === "forget" && content) {
            const before = session.longTermMemory.length;
            session.longTermMemory = session.longTermMemory.filter((m) => !m.toLowerCase().includes(content.toLowerCase()) && !content.toLowerCase().includes(m.toLowerCase()));
            memoryOperation = { operation: "forget", content, removed: before - session.longTermMemory.length };
        }
    }

    // Mode switch (in-memory field, saved via saveSession by the caller)
    let modeSwitch = null;
    if (parsed.mode_switch && typeof parsed.mode_switch === "object") {
        const { mode, style } = parsed.mode_switch;
        let changed = false;
        if (typeof mode === "string" && MODES.includes(mode)) { session.mode = mode; changed = true; }
        if (typeof style === "string" && STYLES.includes(style)) { session.style = style; changed = true; }
        if (changed) modeSwitch = { mode: session.mode, style: session.style };
    }

    // Automation operation — hits jarvis_automations directly
    let automationOperation = null;
    if (parsed.automation_operation && typeof parsed.automation_operation === "object") {
        const op = parsed.automation_operation.operation;
        if (op === "create" && typeof parsed.automation_operation.trigger === "string") {
            const trigger = parsed.automation_operation.trigger.trim();
            const actions = Array.isArray(parsed.automation_operation.actions) ? parsed.automation_operation.actions.filter((a) => a && KNOWN_ACTIONS.includes(a.name)) : [];
            if (trigger && actions.length) {
                const count = await dbCountAutomations(session.sessionId);
                if (count < MAX_AUTOMATIONS) {
                    const automation = await dbCreateAutomation(session.sessionId, trigger, actions);
                    automationOperation = { operation: "create", automation };
                }
            }
        } else if (op === "delete" && typeof parsed.automation_operation.trigger === "string") {
            const removed = await dbDeleteAutomationsByTrigger(session.sessionId, parsed.automation_operation.trigger.trim());
            automationOperation = { operation: "delete", removed };
        } else if (op === "list") {
            const automations = await dbListAutomations(session.sessionId);
            automationOperation = { operation: "list", automations };
        }
    }

    return {
        request_id: requestId,
        type: finalActions.length > 0 ? "action" : "conversation",
        reply,
        actions: finalActions,
        requires_confirmation: anyPendingConfirmation,
        memory_operation: memoryOperation,
        mode_switch: modeSwitch,
        automation_operation: automationOperation
    };
}

// ------------------------------------------------------------
// Error responder — distinguishes DB errors from AI/timeout errors
// ------------------------------------------------------------
function respondToError(res, requestId, error) {
    if (error.message === "TIMEOUT") {
        console.error(`[${requestId}] Groq request timed out.`);
        return res.status(504).json({ error: "JARVIS timed out waiting for a response. Please try again." });
    }
    if (error.isDbError) {
        console.error(`[${requestId}] Supabase error:`, error.message);
        return res.status(500).json({ error: "JARVIS had a database error. Check Supabase configuration." });
    }
    console.error(`[${requestId}] Error:`, error);
    return res.status(502).json({ error: "JARVIS encountered an unexpected error." });
}

// ------------------------------------------------------------
// Routes — core
// ------------------------------------------------------------
app.get("/", (req, res) => {
    res.json({ status: "online", name: "JARVIS", version: "0.7.0", model: GROQ_MODEL, uptimeSeconds: Math.floor((Date.now() - SERVER_START) / 1000), message: "JARVIS AI backend is running." });
});

app.get("/api/health", async (req, res) => {
    let dbOk = true;
    try {
        await sb(supabase.from("jarvis_sessions").select("session_id").limit(1));
    } catch (e) {
        dbOk = false;
    }
    res.status(200).json({ status: "ok", database: dbOk ? "connected" : "unreachable", uptimeSeconds: Math.floor((Date.now() - SERVER_START) / 1000), timestamp: new Date().toISOString() });
});

app.post("/api/chat", async (req, res) => {
    const { message, history, sessionId, verified, deviceState, errors } = extractChatInput(req.body || {});
    if (errors.length > 0) return res.status(400).json({ error: errors.join(" ") });

    try {
        const session = await loadSession(sessionId);
        if (deviceState) session.deviceState = { ...session.deviceState, ...deviceState };

        const systemPrompt = buildSystemPrompt(session);
        const completionPromise = groq.chat.completions.create({
            model: GROQ_MODEL,
            messages: [{ role: "system", content: systemPrompt }, ...session.history, ...history, { role: "user", content: message }],
            temperature: 0.6
        });

        const completion = await withTimeout(completionPromise, GROQ_TIMEOUT_MS);
        const rawText = completion.choices?.[0]?.message?.content;
        if (!rawText) {
            console.error(`[${req.requestId}] Groq returned an empty response.`);
            return res.status(502).json({ error: "JARVIS received an empty response from the AI service." });
        }

        const parsed = safeParseJSON(rawText);
        const structured = await finalizeResponse(parsed, session, req.requestId, { verified });

        pushHistory(session, "user", message);
        pushHistory(session, "assistant", structured.reply);
        await saveSession(session);

        console.log(`[${req.requestId}] mode=${session.mode} type=${structured.type} actions=${structured.actions.map((a) => a.name).join(",") || "none"}`);
        return res.status(200).json(structured);
    } catch (error) {
        return respondToError(res, req.requestId, error);
    }
});

app.post("/api/action-result", async (req, res) => {
    const { sessionId = "default", action, actionId, status, details } = req.body || {};
    if (!action || !["success", "failure"].includes(status)) {
        return res.status(400).json({ error: "Fields 'action' and 'status' ('success'|'failure') are required." });
    }
    try {
        const session = await loadSession(sessionId);
        session.lastActionResult = { action, actionId: actionId || null, status, details: typeof details === "string" ? details : null, timestamp: new Date().toISOString() };
        await saveSession(session);
        console.log(`[${req.requestId}] action-result session=${sessionId} action=${action} status=${status}`);
        res.status(200).json({ status: "recorded" });
    } catch (error) {
        return respondToError(res, req.requestId, error);
    }
});

// ------------------------------------------------------------
// Routes — modes & styles
// ------------------------------------------------------------
app.post("/api/mode", async (req, res) => {
    const { sessionId = "default", mode } = req.body || {};
    if (!MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of: ${MODES.join(", ")}` });
    try {
        const session = await loadSession(sessionId);
        session.mode = mode;
        await saveSession(session);
        res.json({ sessionId, mode: session.mode });
    } catch (error) {
        return respondToError(res, req.requestId, error);
    }
});

app.post("/api/style", async (req, res) => {
    const { sessionId = "default", style } = req.body || {};
    if (!STYLES.includes(style)) return res.status(400).json({ error: `style must be one of: ${STYLES.join(", ")}` });
    try {
        const session = await loadSession(sessionId);
        session.style = style;
        await saveSession(session);
        res.json({ sessionId, style: session.style });
    } catch (error) {
        return respondToError(res, req.requestId, error);
    }
});

// ------------------------------------------------------------
// Routes — skills
// ------------------------------------------------------------
app.get("/api/skills", async (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "default";
    try {
        const session = await loadSession(sessionId);
        const all = Object.entries(SKILLS).map(([name, def]) => ({ name, description: def.description, actions: def.actions, installed: session.installedSkills.has(name) }));
        res.json({ sessionId, skills: all });
    } catch (error) {
        return respondToError(res, req.requestId, error);
    }
});

app.post("/api/skills/install", async (req, res) => {
    const { sessionId = "default", skill } = req.body || {};
    if (!SKILLS[skill]) return res.status(400).json({ error: `Unknown skill "${skill}". Available: ${Object.keys(SKILLS).join(", ")}` });
    try {
        const session = await loadSession(sessionId);
        session.installedSkills.add(skill);
        await saveSession(session);
        res.json({ sessionId, installedSkills: [...session.installedSkills] });
    } catch (error) {
        return respondToError(res, req.requestId, error);
    }
});

app.post("/api/skills/uninstall", async (req, res) => {
    const { sessionId = "default", skill } = req.body || {};
    if (skill === "core") return res.status(400).json({ error: "The core skill can't be uninstalled." });
    try {
        const session = await loadSession(sessionId);
        session.installedSkills.delete(skill);
        await saveSession(session);
        res.json({ sessionId, installedSkills: [...session.installedSkills] });
    } catch (error) {
        return respondToError(res, req.requestId, error);
    }
});

// ------------------------------------------------------------
// Routes — automation engine
// ------------------------------------------------------------
app.get("/api/automations", async (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "default";
    try {
        const automations = await dbListAutomations(sessionId);
        res.json({ sessionId, automations });
    } catch (error) {
        return respondToError(res, req.requestId, error);
    }
});

app.post("/api/automations", async (req, res) => {
    const { sessionId = "default", trigger, actions } = req.body || {};
    if (!trigger || typeof trigger !== "string") return res.status(400).json({ error: "Field 'trigger' is required." });
    if (!Array.isArray(actions) || actions.length === 0) return res.status(400).json({ error: "Field 'actions' must be a non-empty array." });

    const cleanActions = actions.filter((a) => a && KNOWN_ACTIONS.includes(a.name));
    if (cleanActions.length === 0) return res.status(400).json({ error: "No valid actions provided." });

    try {
        await loadSession(sessionId); // ensure the session row exists (FK requirement)
        const count = await dbCountAutomations(sessionId);
        if (count >= MAX_AUTOMATIONS) return res.status(400).json({ error: "Automation limit reached for this session." });

        const automation = await dbCreateAutomation(sessionId, trigger.trim(), cleanActions);
        res.status(201).json({ sessionId, automation });
    } catch (error) {
        return respondToError(res, req.requestId, error);
    }
});

app.delete("/api/automations/:id", async (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "default";
    try {
        const removed = await dbDeleteAutomationById(sessionId, req.params.id);
        if (removed === 0) return res.status(404).json({ error: "Automation not found." });
        res.json({ status: "deleted", sessionId });
    } catch (error) {
        return respondToError(res, req.requestId, error);
    }
});

app.post("/api/trigger", async (req, res) => {
    const { sessionId = "default", triggerName, verified } = req.body || {};
    if (!triggerName || typeof triggerName !== "string") return res.status(400).json({ error: "Field 'triggerName' is required." });

    try {
        const session = await loadSession(sessionId);
        const matches = await dbFindAutomationsByTrigger(sessionId, triggerName.trim());

        if (matches.length === 0) {
            return res.status(200).json({ request_id: req.requestId, type: "conversation", reply: null, actions: [], matched: 0 });
        }

        const allRawActions = matches.flatMap((a) => a.actions);
        const { finalActions, anyPendingConfirmation, notes } = validateAndTierActions(allRawActions, session, { verified: verified === true });
        await saveSession(session); // pendingConfirmation may have changed

        console.log(`[${req.requestId}] trigger="${triggerName}" matched=${matches.length} actions=${finalActions.map((a) => a.name).join(",") || "none"}`);

        res.status(200).json({
            request_id: req.requestId,
            type: finalActions.length > 0 ? "action" : "conversation",
            reply: notes.join(" ") || `Automation "${triggerName}" triggered.`,
            actions: finalActions,
            requires_confirmation: anyPendingConfirmation,
            matched: matches.length
        });
    } catch (error) {
        return respondToError(res, req.requestId, error);
    }
});

// ------------------------------------------------------------
// Routes — proactive nudges (budgeted)
// ------------------------------------------------------------
app.post("/api/proactive-check", async (req, res) => {
    const { sessionId = "default", deviceState } = req.body || {};
    try {
        const session = await loadSession(sessionId);
        if (deviceState && typeof deviceState === "object") session.deviceState = { ...session.deviceState, ...deviceState };

        const today = todayStr();
        if (session.proactive.date !== today) session.proactive = { date: today, count: 0 };

        if (session.mode === "focus") { await saveSession(session); return res.json({ nudge: null, reason: "focus_mode" }); }
        if (session.proactive.count >= PROACTIVE_DAILY_BUDGET) { await saveSession(session); return res.json({ nudge: null, reason: "budget_exhausted" }); }

        const ds = session.deviceState || {};
        let heuristicReason = null;
        if (typeof ds.battery === "number" && ds.battery <= 15 && !ds.charging) heuristicReason = "low_battery";
        else if (typeof ds.time === "string") {
            const hour = parseInt(ds.time.split(":")[0], 10);
            if (!isNaN(hour) && hour >= 0 && hour < 5) heuristicReason = "late_night";
        }

        if (!heuristicReason) { await saveSession(session); return res.json({ nudge: null, reason: "no_trigger" }); }

        const prompt = heuristicReason === "low_battery"
            ? `Device state: ${JSON.stringify(ds)}. Battery is low and not charging. Write ONE short, natural nudge to Bless about it (as JARVIS). Return ONLY the sentence, no JSON.`
            : `Device state: ${JSON.stringify(ds)}. It's very late at night and Bless appears active. Write ONE short, natural, lightly witty nudge (as JARVIS). Return ONLY the sentence, no JSON.`;

        const completion = await withTimeout(
            groq.chat.completions.create({ model: GROQ_MODEL, messages: [{ role: "system", content: "You are JARVIS, a personal AI assistant for Bless. Reply with one short natural sentence only." }, { role: "user", content: prompt }], temperature: 0.7 }),
            GROQ_TIMEOUT_MS
        );

        const nudge = completion.choices?.[0]?.message?.content?.trim() || null;
        if (nudge) session.proactive.count += 1;
        await saveSession(session);

        res.json({ nudge, reason: heuristicReason, budgetRemaining: PROACTIVE_DAILY_BUDGET - session.proactive.count });
    } catch (error) {
        return respondToError(res, req.requestId, error);
    }
});

// ------------------------------------------------------------
// Routes — vision (stateless, no session needed)
// ------------------------------------------------------------
app.post("/api/vision", async (req, res) => {
    const { question, image_base64, mime_type = "image/jpeg" } = req.body || {};
    if (!image_base64 || typeof image_base64 !== "string") return res.status(400).json({ error: "Field 'image_base64' is required." });

    try {
        const completionPromise = groq.chat.completions.create({
            model: GROQ_VISION_MODEL,
            messages: [{
                role: "user",
                content: [
                    { type: "text", text: question && typeof question === "string" ? question : "Describe what's in this image, concisely, as JARVIS speaking to Bless." },
                    { type: "image_url", image_url: { url: `data:${mime_type};base64,${image_base64}` } }
                ]
            }]
        });
        const completion = await withTimeout(completionPromise, GROQ_TIMEOUT_MS);
        const reply = completion.choices?.[0]?.message?.content?.trim() || "I couldn't make sense of that image.";
        res.json({ request_id: req.requestId, type: "conversation", reply });
    } catch (error) {
        if (error.message === "TIMEOUT") return res.status(504).json({ error: "Vision request timed out." });
        console.error(`[${req.requestId}] Vision error:`, error);
        res.status(502).json({ error: "JARVIS couldn't process that image. Check that GROQ_VISION_MODEL is set to a vision-capable model your account has access to." });
    }
});

// ------------------------------------------------------------
// Routes — capability registry / evolution log / status
// ------------------------------------------------------------
const EVOLUTION_LOG = [
    { version: "0.1", capabilities: ["chat"] },
    { version: "0.2", capabilities: ["chat", "groq"] },
    { version: "0.3", capabilities: ["chat", "groq", "actions"] },
    { version: "0.4", capabilities: ["chat", "groq", "actions", "android_shizuku_ready"] },
    { version: "0.5", capabilities: ["chat", "groq", "actions", "android_shizuku_ready", "memory", "confirmation_flow", "action_verification"] },
    { version: "0.6", capabilities: ["chat", "groq", "actions", "android_shizuku_ready", "memory", "confirmation_flow", "action_verification", "modes", "styles", "skills", "automations", "proactive_nudges", "sensitive_tier", "vision"] },
    { version: "0.7", capabilities: ["chat", "groq", "actions", "android_shizuku_ready", "memory", "confirmation_flow", "action_verification", "modes", "styles", "skills", "automations", "proactive_nudges", "sensitive_tier", "vision", "supabase_persistence"] }
];

app.get("/api/capabilities", async (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "default";
    try {
        const session = await loadSession(sessionId);
        const availableActions = CALLABLE_ACTIONS.filter((a) => { const s = skillForAction(a); return !s || session.installedSkills.has(s); });
        res.json({ currentVersion: EVOLUTION_LOG[EVOLUTION_LOG.length - 1].version, evolutionLog: EVOLUTION_LOG, installedSkills: [...session.installedSkills], availableActions });
    } catch (error) {
        return respondToError(res, req.requestId, error);
    }
});

app.get("/api/status", async (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "default";
    try {
        const session = await loadSession(sessionId);
        const automationsCount = await dbCountAutomations(sessionId);
        res.json({
            sessionId, mode: session.mode, style: session.style, installedSkills: [...session.installedSkills],
            automationsCount, longTermMemoryCount: session.longTermMemory.length,
            pendingConfirmation: session.pendingConfirmation, lastActionResult: session.lastActionResult,
            deviceState: session.deviceState, proactive: session.proactive,
            uptimeSeconds: Math.floor((Date.now() - SERVER_START) / 1000)
        });
    } catch (error) {
        return respondToError(res, req.requestId, error);
    }
});

// ------------------------------------------------------------
// Routes — memory + reset
// ------------------------------------------------------------
app.get("/api/memory", async (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "default";
    try {
        const session = await loadSession(sessionId);
        res.json({ sessionId, longTermMemory: session.longTermMemory, pendingConfirmation: session.pendingConfirmation, lastActionResult: session.lastActionResult });
    } catch (error) {
        return respondToError(res, req.requestId, error);
    }
});

// Deletes the session row AND its automations (ON DELETE CASCADE)
app.post("/api/reset", async (req, res) => {
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : "default";
    try {
        await sb(supabase.from("jarvis_sessions").delete().eq("session_id", sessionId));
        res.json({ status: "cleared", sessionId });
    } catch (error) {
        return respondToError(res, req.requestId, error);
    }
});

// ------------------------------------------------------------
// 404 + global error handlers
// ------------------------------------------------------------
app.use((req, res) => res.status(404).json({ error: "Route not found." }));
app.use((err, req, res, next) => {
    console.error("Unhandled server error:", err);
    res.status(500).json({ error: "Internal server error." });
});

// ------------------------------------------------------------
// Start server
// ------------------------------------------------------------
app.listen(PORT, () => {
    console.log(`JARVIS AI backend (v0.7) running on port ${PORT} (model: ${GROQ_MODEL}, vision: ${GROQ_VISION_MODEL}, db: Supabase)`);
});
