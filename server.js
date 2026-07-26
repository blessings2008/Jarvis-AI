/**
 * ============================================================
 *  J.A.R.V.I.S. — Cloud AI Brain (v0.6)
 *  Just A Rather Very Intelligent System
 *
 *  New in v0.6 (on top of the v0.5 brain):
 *   - Brain-state modes (conversation/command/focus/developer/
 *     study/hustle/emergency) + interaction styles (professional/
 *     casual/technical/tutor/motivator)
 *   - Situational awareness: client-supplied device state folded
 *     into every response
 *   - Skill/plugin system: actions are grouped into skills that
 *     must be "installed" before JARVIS can use them
 *   - Automation engine: define trigger -> actions rules, fire
 *     them deterministically via /api/trigger (no AI call needed)
 *   - SENSITIVE action tier: confirmation AND device-verified
 *     flag required (foundation for biometric/PIN gating, which
 *     the Android app performs and reports back via `verified`)
 *   - Proactive nudges with a daily budget, so it doesn't spam
 *   - Capability registry + a simple version/evolution log
 *   - Vision endpoint (image + question) — model configurable,
 *     since vision-capable model availability on Groq changes
 *
 *  Still true from v0.5: JARVIS never executes device actions
 *  itself, never claims an action succeeded without a reported
 *  result, and always returns structured JSON.
 * ============================================================
 */

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const Groq = require("groq-sdk");
require("dotenv").config();

// ------------------------------------------------------------
// Environment / configuration
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
// Vision-capable model availability on Groq changes over time —
// set this explicitly to whatever vision model your Groq account
// currently has access to. Falls back to GROQ_MODEL, which may
// NOT support images, so /api/vision will error clearly if so.
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || GROQ_MODEL;

if (!GROQ_API_KEY) {
    console.error("FATAL: GROQ_API_KEY is not set. Add it to your .env file.");
    process.exit(1);
}

const groq = new Groq({ apiKey: GROQ_API_KEY });
const GROQ_TIMEOUT_MS = 15000;
const SERVER_START = Date.now();

// ------------------------------------------------------------
// App setup
// ------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" })); // higher limit to allow base64 images for /api/vision

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
// Skill registry — groups actions into installable units.
// "core" is installed by default; everything else must be
// explicitly installed before JARVIS will use its actions.
// ------------------------------------------------------------
const SKILLS = {
    core: {
        description: "Basic device actions",
        actions: ["open_app", "close_app", "screenshot", "battery_status", "volume_up", "volume_down", "open_url", "get_location", "take_photo"]
    },
    communication: {
        description: "Sending messages and making calls",
        actions: ["send_message", "make_call"]
    },
    system: {
        description: "System-level control (reboot, etc.)",
        actions: ["reboot"]
    },
    privacy: {
        description: "Access to private/sensitive data — requires device verification",
        actions: ["open_private_files"]
    }
};
const DEFAULT_SKILLS = ["core"];

// Action permission tiers. SENSITIVE = confirmation AND a
// device-verified flag (biometric/PIN, checked by the Android
// app) before it's allowed through.
const ACTION_TIERS = {
    open_app: "SAFE",
    close_app: "SAFE",
    screenshot: "SAFE",
    battery_status: "SAFE",
    volume_up: "SAFE",
    volume_down: "SAFE",
    open_url: "SAFE",
    get_location: "SAFE",
    take_photo: "SAFE",
    reboot: "CONFIRMATION_REQUIRED",
    send_message: "CONFIRMATION_REQUIRED",
    make_call: "CONFIRMATION_REQUIRED",
    open_private_files: "SENSITIVE",
    delete_file: "BLOCKED" // reserved / not yet supported — demonstrates the tier
};
const KNOWN_ACTIONS = Object.keys(ACTION_TIERS);
const CALLABLE_ACTIONS = KNOWN_ACTIONS.filter((a) => ACTION_TIERS[a] !== "BLOCKED");

function skillForAction(actionName) {
    return Object.keys(SKILLS).find((s) => SKILLS[s].actions.includes(actionName)) || null;
}

// ------------------------------------------------------------
// Modes (operating state) + Styles (interaction tone)
// ------------------------------------------------------------
const MODES = ["conversation", "command", "focus", "developer", "study", "hustle", "emergency"];
const STYLES = ["adaptive", "professional", "casual", "technical", "tutor", "motivator"];

const MODE_DESCRIPTIONS = {
    conversation: "Normal open-ended chat.",
    command: "Bless wants things done — bias toward proposing actions over chatting.",
    focus: "Bless is focusing — keep replies minimal, avoid unnecessary chatter, no proactive nudges.",
    developer: "Coding-focused — precise, technical, comfortable with jargon.",
    study: "Tutoring/quiz mode — explain concepts clearly, check understanding, ask questions back.",
    hustle: "Business/productivity mode — brisk, action-oriented, prioritize what moves things forward.",
    emergency: "Urgent — be extremely direct and prioritize the single most important action."
};

// ------------------------------------------------------------
// Session store
// ------------------------------------------------------------
const sessions = new Map();
const MAX_HISTORY = 20;
const MAX_MEMORY_ITEMS = 50;
const MAX_AUTOMATIONS = 25;
const PROACTIVE_DAILY_BUDGET = 5;

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

function getSession(sessionId) {
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
            history: [],
            longTermMemory: [],
            pendingConfirmation: null, // {action, parameters, requiresVerification}
            lastActionResult: null,
            mode: "conversation",
            style: "adaptive",
            installedSkills: new Set(DEFAULT_SKILLS),
            automations: [], // {id, trigger, actions:[{name,parameters}], createdAt}
            deviceState: null, // {battery, charging, time, currentApp, internet, ...}
            proactive: { date: todayStr(), count: 0 }
        });
    }
    return sessions.get(sessionId);
}

function pushHistory(session, role, content) {
    session.history.push({ role, content });
    if (session.history.length > MAX_HISTORY) {
        session.history.splice(0, session.history.length - MAX_HISTORY);
    }
}

// ------------------------------------------------------------
// Shared action validation/tiering — used by both the chat
// endpoint (AI-proposed actions) and the automation trigger
// endpoint (pre-defined actions), so the rules are enforced
// identically either way.
// ------------------------------------------------------------
function validateAndTierActions(rawActions, session, { verified = false } = {}) {
    const finalActions = [];
    let anyPendingConfirmation = false;
    const notes = [];

    rawActions.forEach((a) => {
        if (!a || typeof a.name !== "string") return;
        const name = a.name;
        const parameters = a.parameters && typeof a.parameters === "object" ? a.parameters : {};

        if (!KNOWN_ACTIONS.includes(name)) return; // unknown/hallucinated — drop

        const tier = ACTION_TIERS[name];

        if (tier === "BLOCKED") {
            notes.push(`"${name}" is restricted and not available.`);
            return;
        }

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
                // Confirmed AND device-verified this turn — clear to go.
                session.pendingConfirmation = null;
                finalActions.push({ id: `action_${String(finalActions.length + 1).padStart(3, "0")}`, name, parameters, requires_confirmation: false, requires_verification: false });
            } else if (confirmingPending && !verified) {
                // Confirmed but not yet verified — keep pending, ask for verification specifically.
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
// System prompt — identity, schema, live session context
// ------------------------------------------------------------
function buildSystemPrompt(session) {
    const memoryBlock = session.longTermMemory.length
        ? session.longTermMemory.map((m, i) => `${i + 1}. ${m}`).join("\n")
        : "(nothing remembered yet)";

    const pendingBlock = session.pendingConfirmation
        ? `PENDING action awaiting the user: "${session.pendingConfirmation.action}" (params ${JSON.stringify(session.pendingConfirmation.parameters)})${session.pendingConfirmation.requiresVerification ? " — also requires device verification" : ""}. If the user confirms, return that exact action in "actions". If they decline, don't return it — just acknowledge.`
        : "No pending action right now.";

    const lastResultBlock = session.lastActionResult
        ? `Last reported action result: "${session.lastActionResult.action}" → ${session.lastActionResult.status}${session.lastActionResult.details ? " (" + session.lastActionResult.details + ")" : ""}. Never claim success unless this confirms it.`
        : "No action results reported yet.";

    const installedSkillsList = [...session.installedSkills].join(", ") || "none";
    const availableActionsForSkills = CALLABLE_ACTIONS.filter((a) => {
        const s = skillForAction(a);
        return !s || session.installedSkills.has(s);
    });

    const deviceStateBlock = session.deviceState
        ? `Current device state: ${JSON.stringify(session.deviceState)}. Use this naturally if relevant (e.g. mention low battery) — don't recite it unprompted every message.`
        : "No device state has been shared yet.";

    return `You are JARVIS (Just A Rather Very Intelligent System), a personal AI assistant built for a user named Bless. You are an original assistant, not the fictional Marvel character — never reference Marvel, Iron Man, or Tony Stark.

CURRENT MODE: "${session.mode}" — ${MODE_DESCRIPTIONS[session.mode]}
CURRENT STYLE: "${session.style}"${session.style === "adaptive" ? " — match tone to the message: casual and warm for casual messages, precise and professional for technical ones." : ` — maintain a consistently ${session.style} tone.`}

CRITICAL RULE: Never claim an action was completed. You only ever REQUEST an action; the Android app executes it and reports success/failure back. Describe what you're about to do, not what already happened.

${lastResultBlock}

${deviceStateBlock}

INSTALLED SKILLS: ${installedSkillsList}
ACTIONS YOU MAY USE RIGHT NOW: ${availableActionsForSkills.join(", ")}
(Other actions exist but need their skill installed first — if the user asks for one, tell them which skill to install rather than attempting it.)

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
- Only set "mode_switch" when the user clearly asks to change mode/style (e.g. "activate developer mode", "switch to casual").
- Only set "automation_operation" when the user is clearly defining, removing, or asking to list automations (e.g. "whenever X happens, do Y").
- Never perform or claim to perform anything yourself — you only describe intent.

Return ONLY the JSON object.`;
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function withTimeout(promise, ms) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("TIMEOUT")), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function safeParseJSON(rawText) {
    try {
        return JSON.parse(rawText.replace(/```json|```/g, "").trim());
    } catch (err) {
        return null;
    }
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

/** Enforce schema + tiers + confirmation + memory + mode + automation ops. Mutates session. */
function finalizeResponse(parsed, session, requestId, { verified }) {
    if (!parsed || typeof parsed !== "object") {
        return {
            request_id: requestId,
            type: "conversation",
            reply: "I had trouble putting that into words, Bless — could you rephrase?",
            actions: [],
            requires_confirmation: false,
            memory_operation: null,
            mode_switch: null,
            automation_operation: null
        };
    }

    let reply = typeof parsed.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : "I'm not sure how to respond to that, Bless.";

    const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];
    const { finalActions, anyPendingConfirmation, notes } = validateAndTierActions(rawActions, session, { verified });
    if (notes.length) reply = `${reply} (${notes.join(" ")})`.trim();

    // Memory operation
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

    // Mode switch
    let modeSwitch = null;
    if (parsed.mode_switch && typeof parsed.mode_switch === "object") {
        const { mode, style } = parsed.mode_switch;
        let changed = false;
        if (typeof mode === "string" && MODES.includes(mode)) { session.mode = mode; changed = true; }
        if (typeof style === "string" && STYLES.includes(style)) { session.style = style; changed = true; }
        if (changed) modeSwitch = { mode: session.mode, style: session.style };
    }

    // Automation operation
    let automationOperation = null;
    if (parsed.automation_operation && typeof parsed.automation_operation === "object") {
        const op = parsed.automation_operation.operation;
        if (op === "create" && typeof parsed.automation_operation.trigger === "string") {
            const trigger = parsed.automation_operation.trigger.trim();
            const actions = Array.isArray(parsed.automation_operation.actions) ? parsed.automation_operation.actions.filter((a) => a && KNOWN_ACTIONS.includes(a.name)) : [];
            if (trigger && actions.length && session.automations.length < MAX_AUTOMATIONS) {
                const automation = { id: crypto.randomUUID(), trigger, actions, createdAt: new Date().toISOString() };
                session.automations.push(automation);
                automationOperation = { operation: "create", automation };
            }
        } else if (op === "delete" && typeof parsed.automation_operation.trigger === "string") {
            const trigger = parsed.automation_operation.trigger.trim().toLowerCase();
            const before = session.automations.length;
            session.automations = session.automations.filter((a) => a.trigger.toLowerCase() !== trigger);
            automationOperation = { operation: "delete", removed: before - session.automations.length };
        } else if (op === "list") {
            automationOperation = { operation: "list", automations: session.automations };
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
// Routes — core
// ------------------------------------------------------------
app.get("/", (req, res) => {
    res.json({
        status: "online",
        name: "JARVIS",
        version: "0.6.0",
        model: GROQ_MODEL,
        uptimeSeconds: Math.floor((Date.now() - SERVER_START) / 1000),
        message: "JARVIS AI backend is running."
    });
});

app.get("/api/health", (req, res) => {
    res.status(200).json({ status: "ok", uptimeSeconds: Math.floor((Date.now() - SERVER_START) / 1000), timestamp: new Date().toISOString() });
});

// Main brain endpoint
app.post("/api/chat", async (req, res) => {
    const { message, history, sessionId, verified, deviceState, errors } = extractChatInput(req.body || {});
    if (errors.length > 0) return res.status(400).json({ error: errors.join(" ") });

    const session = getSession(sessionId);
    if (deviceState) session.deviceState = { ...session.deviceState, ...deviceState };

    try {
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
        const structured = finalizeResponse(parsed, session, req.requestId, { verified });

        pushHistory(session, "user", message);
        pushHistory(session, "assistant", structured.reply);

        console.log(`[${req.requestId}] mode=${session.mode} type=${structured.type} actions=${structured.actions.map((a) => a.name).join(",") || "none"}`);
        return res.status(200).json(structured);
    } catch (error) {
        if (error.message === "TIMEOUT") {
            console.error(`[${req.requestId}] Groq request timed out.`);
            return res.status(504).json({ error: "JARVIS timed out waiting for a response. Please try again." });
        }
        console.error(`[${req.requestId}] Groq API error:`, error);
        return res.status(502).json({ error: "JARVIS encountered an error communicating with the AI service." });
    }
});

// Action result verification loop
app.post("/api/action-result", (req, res) => {
    const { sessionId = "default", action, actionId, status, details } = req.body || {};
    if (!action || !["success", "failure"].includes(status)) {
        return res.status(400).json({ error: "Fields 'action' and 'status' ('success'|'failure') are required." });
    }
    const session = getSession(sessionId);
    session.lastActionResult = { action, actionId: actionId || null, status, details: typeof details === "string" ? details : null, timestamp: new Date().toISOString() };
    console.log(`[${req.requestId}] action-result session=${sessionId} action=${action} status=${status}`);
    res.status(200).json({ status: "recorded" });
});

// ------------------------------------------------------------
// Routes — modes & styles (dedicated, for reliable UI buttons)
// ------------------------------------------------------------
app.post("/api/mode", (req, res) => {
    const { sessionId = "default", mode } = req.body || {};
    if (!MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of: ${MODES.join(", ")}` });
    const session = getSession(sessionId);
    session.mode = mode;
    res.json({ sessionId, mode: session.mode });
});

app.post("/api/style", (req, res) => {
    const { sessionId = "default", style } = req.body || {};
    if (!STYLES.includes(style)) return res.status(400).json({ error: `style must be one of: ${STYLES.join(", ")}` });
    const session = getSession(sessionId);
    session.style = style;
    res.json({ sessionId, style: session.style });
});

// ------------------------------------------------------------
// Routes — skills
// ------------------------------------------------------------
app.get("/api/skills", (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "default";
    const session = getSession(sessionId);
    const all = Object.entries(SKILLS).map(([name, def]) => ({ name, description: def.description, actions: def.actions, installed: session.installedSkills.has(name) }));
    res.json({ sessionId, skills: all });
});

app.post("/api/skills/install", (req, res) => {
    const { sessionId = "default", skill } = req.body || {};
    if (!SKILLS[skill]) return res.status(400).json({ error: `Unknown skill "${skill}". Available: ${Object.keys(SKILLS).join(", ")}` });
    const session = getSession(sessionId);
    session.installedSkills.add(skill);
    res.json({ sessionId, installedSkills: [...session.installedSkills] });
});

app.post("/api/skills/uninstall", (req, res) => {
    const { sessionId = "default", skill } = req.body || {};
    const session = getSession(sessionId);
    if (skill === "core") return res.status(400).json({ error: "The core skill can't be uninstalled." });
    session.installedSkills.delete(skill);
    res.json({ sessionId, installedSkills: [...session.installedSkills] });
});

// ------------------------------------------------------------
// Routes — automation engine
// ------------------------------------------------------------
app.get("/api/automations", (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "default";
    const session = getSession(sessionId);
    res.json({ sessionId, automations: session.automations });
});

app.post("/api/automations", (req, res) => {
    const { sessionId = "default", trigger, actions } = req.body || {};
    if (!trigger || typeof trigger !== "string") return res.status(400).json({ error: "Field 'trigger' is required." });
    if (!Array.isArray(actions) || actions.length === 0) return res.status(400).json({ error: "Field 'actions' must be a non-empty array." });

    const cleanActions = actions.filter((a) => a && KNOWN_ACTIONS.includes(a.name));
    if (cleanActions.length === 0) return res.status(400).json({ error: "No valid actions provided." });

    const session = getSession(sessionId);
    if (session.automations.length >= MAX_AUTOMATIONS) return res.status(400).json({ error: "Automation limit reached for this session." });

    const automation = { id: crypto.randomUUID(), trigger: trigger.trim(), actions: cleanActions, createdAt: new Date().toISOString() };
    session.automations.push(automation);
    res.status(201).json({ sessionId, automation });
});

app.delete("/api/automations/:id", (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "default";
    const session = getSession(sessionId);
    const before = session.automations.length;
    session.automations = session.automations.filter((a) => a.id !== req.params.id);
    if (session.automations.length === before) return res.status(404).json({ error: "Automation not found." });
    res.json({ status: "deleted", sessionId });
});

// Fire a trigger deterministically — no AI call, so it's fast and
// reliable for things like "SMS received" events from Android.
app.post("/api/trigger", (req, res) => {
    const { sessionId = "default", triggerName, verified } = req.body || {};
    if (!triggerName || typeof triggerName !== "string") return res.status(400).json({ error: "Field 'triggerName' is required." });

    const session = getSession(sessionId);
    const matches = session.automations.filter((a) => a.trigger.toLowerCase() === triggerName.trim().toLowerCase());

    if (matches.length === 0) {
        return res.status(200).json({ request_id: req.requestId, type: "conversation", reply: null, actions: [], matched: 0 });
    }

    const allRawActions = matches.flatMap((a) => a.actions);
    const { finalActions, anyPendingConfirmation, notes } = validateAndTierActions(allRawActions, session, { verified: verified === true });

    console.log(`[${req.requestId}] trigger="${triggerName}" matched=${matches.length} actions=${finalActions.map((a) => a.name).join(",") || "none"}`);

    res.status(200).json({
        request_id: req.requestId,
        type: finalActions.length > 0 ? "action" : "conversation",
        reply: notes.join(" ") || `Automation "${triggerName}" triggered.`,
        actions: finalActions,
        requires_confirmation: anyPendingConfirmation,
        matched: matches.length
    });
});

// ------------------------------------------------------------
// Routes — proactive nudges (budgeted)
// ------------------------------------------------------------
// Android should call this periodically (e.g. every 15-30 min)
// with the current device state. JARVIS only speaks up if a
// heuristic condition is met AND the daily budget allows it —
// this keeps it useful instead of annoying.
app.post("/api/proactive-check", async (req, res) => {
    const { sessionId = "default", deviceState } = req.body || {};
    const session = getSession(sessionId);
    if (deviceState && typeof deviceState === "object") session.deviceState = { ...session.deviceState, ...deviceState };

    // Reset budget on a new day
    const today = todayStr();
    if (session.proactive.date !== today) session.proactive = { date: today, count: 0 };

    if (session.mode === "focus") {
        return res.json({ nudge: null, reason: "focus_mode" });
    }
    if (session.proactive.count >= PROACTIVE_DAILY_BUDGET) {
        return res.json({ nudge: null, reason: "budget_exhausted" });
    }

    // Simple, cheap heuristics — no AI call unless one actually triggers,
    // to avoid burning Groq quota on routine polling.
    const ds = session.deviceState || {};
    let heuristicReason = null;
    if (typeof ds.battery === "number" && ds.battery <= 15 && !ds.charging) heuristicReason = "low_battery";
    else if (typeof ds.time === "string") {
        const hour = parseInt(ds.time.split(":")[0], 10);
        if (!isNaN(hour) && hour >= 0 && hour < 5) heuristicReason = "late_night";
    }

    if (!heuristicReason) {
        return res.json({ nudge: null, reason: "no_trigger" });
    }

    try {
        const prompt = heuristicReason === "low_battery"
            ? `Device state: ${JSON.stringify(ds)}. Battery is low and not charging. Write ONE short, natural nudge to Bless about it (as JARVIS). Return ONLY the sentence, no JSON.`
            : `Device state: ${JSON.stringify(ds)}. It's very late at night and Bless appears active. Write ONE short, natural, lightly witty nudge (as JARVIS). Return ONLY the sentence, no JSON.`;

        const completion = await withTimeout(
            groq.chat.completions.create({ model: GROQ_MODEL, messages: [{ role: "system", content: "You are JARVIS, a personal AI assistant for Bless. Reply with one short natural sentence only." }, { role: "user", content: prompt }], temperature: 0.7 }),
            GROQ_TIMEOUT_MS
        );

        const nudge = completion.choices?.[0]?.message?.content?.trim() || null;
        if (nudge) session.proactive.count += 1;

        res.json({ nudge, reason: heuristicReason, budgetRemaining: PROACTIVE_DAILY_BUDGET - session.proactive.count });
    } catch (error) {
        console.error(`[${req.requestId}] proactive-check error:`, error);
        res.json({ nudge: null, reason: "error" });
    }
});

// ------------------------------------------------------------
// Routes — vision (image understanding)
// ------------------------------------------------------------
// Body: { sessionId, question, image_base64, mime_type }
// NOTE: requires a vision-capable model set via GROQ_VISION_MODEL.
app.post("/api/vision", async (req, res) => {
    const { sessionId = "default", question, image_base64, mime_type = "image/jpeg" } = req.body || {};
    if (!image_base64 || typeof image_base64 !== "string") return res.status(400).json({ error: "Field 'image_base64' is required." });

    try {
        const completionPromise = groq.chat.completions.create({
            model: GROQ_VISION_MODEL,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: question && typeof question === "string" ? question : "Describe what's in this image, concisely, as JARVIS speaking to Bless." },
                        { type: "image_url", image_url: { url: `data:${mime_type};base64,${image_base64}` } }
                    ]
                }
            ]
        });

        const completion = await withTimeout(completionPromise, GROQ_TIMEOUT_MS);
        const reply = completion.choices?.[0]?.message?.content?.trim() || "I couldn't make sense of that image.";
        res.json({ request_id: req.requestId, type: "conversation", reply, sessionId });
    } catch (error) {
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
    { version: "0.6", capabilities: ["chat", "groq", "actions", "android_shizuku_ready", "memory", "confirmation_flow", "action_verification", "modes", "styles", "skills", "automations", "proactive_nudges", "sensitive_tier", "vision"] }
];

app.get("/api/capabilities", (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "default";
    const session = getSession(sessionId);
    const availableActions = CALLABLE_ACTIONS.filter((a) => {
        const s = skillForAction(a);
        return !s || session.installedSkills.has(s);
    });
    res.json({
        currentVersion: EVOLUTION_LOG[EVOLUTION_LOG.length - 1].version,
        evolutionLog: EVOLUTION_LOG,
        installedSkills: [...session.installedSkills],
        availableActions
    });
});

// Consolidated snapshot — handy for a future dashboard, no dashboard included here.
app.get("/api/status", (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "default";
    const session = getSession(sessionId);
    res.json({
        sessionId,
        mode: session.mode,
        style: session.style,
        installedSkills: [...session.installedSkills],
        automationsCount: session.automations.length,
        longTermMemoryCount: session.longTermMemory.length,
        pendingConfirmation: session.pendingConfirmation,
        lastActionResult: session.lastActionResult,
        deviceState: session.deviceState,
        proactive: session.proactive,
        uptimeSeconds: Math.floor((Date.now() - SERVER_START) / 1000)
    });
});

// ------------------------------------------------------------
// Routes — memory + reset (from v0.5)
// ------------------------------------------------------------
app.get("/api/memory", (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "default";
    const session = getSession(sessionId);
    res.json({ sessionId, longTermMemory: session.longTermMemory, pendingConfirmation: session.pendingConfirmation, lastActionResult: session.lastActionResult });
});

app.post("/api/reset", (req, res) => {
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : "default";
    sessions.delete(sessionId);
    res.json({ status: "cleared", sessionId });
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
    console.log(`JARVIS AI backend (v0.6) running on port ${PORT} (model: ${GROQ_MODEL}, vision: ${GROQ_VISION_MODEL})`);
});
