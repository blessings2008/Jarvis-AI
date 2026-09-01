require("dotenv").config();
const express = require("express"); const cors = require("cors"); const Groq = require("groq-sdk"); const { createClient } = require("@supabase/supabase-js");
const { Cortex } = require("./cognitive/cortex"); const { LearningEngine } = require("./cognitive/learning"); const { Memory } = require("./cognitive/memory"); const { SelfModel } = require("./cognitive/self-model"); const { ToolRegistry } = require("./cognitive/tool-registry"); const { ProcedureStore } = require("./cognitive/procedure-store"); const { CapabilityBus } = require("./cognitive/capability-bus"); const { WorldModel } = require("./cognitive/world-model"); const { Authority } = require("./cognitive/authority");

const app = express(); app.use(cors()); app.use(express.json({ limit: "5mb" }));
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY }); const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const tools = new ToolRegistry(); const memory = new Memory(supabase); const selfModel = new SelfModel(supabase); const procedures = new ProcedureStore(supabase); const capabilityBus = new CapabilityBus(supabase); const worldModel = new WorldModel(supabase); const authority = new Authority();
const learning = new LearningEngine({ db: supabase, memory, selfModel, procedures });
const cortex = new Cortex({ model: process.env.GROQ_MODEL || "openai/gpt-oss-20b", client: groq, memory, selfModel, tools, worldModel, procedures, learning });

async function hydrateSessionCapabilities(sessionId) {
  const saved = await capabilityBus.list(sessionId);
  for (const capability of saved) {
    tools.register(sessionId, { ...capability, execute: async args => ({ dispatch: true, name: capability.name, arguments: args }), authorize: async (args, context) => (await authority.authorize(capability, args, context)).allowed });
  }
  await selfModel.update(sessionId, { field: "known_capabilities", value: saved.map(c => c.name) });
  return saved;
}

app.post("/api/capabilities", async (req, res) => {
  const sessionId = String(req.body?.sessionId || "").trim(); const incoming = Array.isArray(req.body?.capabilities) ? req.body.capabilities : [];
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  try {
    for (const capability of incoming) {
      if (!capability?.name) continue;
      const saved = await capabilityBus.register(sessionId, capability);
      tools.register(sessionId, { name: saved.name, description: saved.description, parameters: saved.parameters, risk: saved.risk, execute: async args => ({ dispatch: true, name: saved.name, arguments: args }), authorize: async (args, context) => (await authority.authorize(saved, args, context)).allowed });
    }
    const capabilities = await hydrateSessionCapabilities(sessionId);
    await worldModel.registerCapabilities(sessionId, capabilities);
    res.json({ ok: true, capabilities });
  } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
});

app.post("/api/world", async (req, res) => { const sessionId = String(req.body?.sessionId || "").trim(); if (!sessionId) return res.status(400).json({ error: "sessionId required" }); try { res.json({ ok: true, world: await worldModel.observe(sessionId, req.body?.observation || {}) }); } catch (error) { res.status(500).json({ ok: false, error: error.message }); } });
app.get("/api/health", async (_req, res) => { const { error } = await supabase.from("jarvis_sessions").select("session_id").limit(1); res.json({ ok: true, brain: "cognitive-v1", database: error ? "unreachable" : "connected" }); });
app.get("/api/self", async (req, res) => { const sessionId = String(req.query.sessionId || ""); if (!sessionId) return res.status(400).json({ error: "sessionId required" }); try { res.json(await selfModel.ensure(sessionId)); } catch (error) { res.status(500).json({ error: error.message }); } });
app.get("/api/world", async (req, res) => { const sessionId = String(req.query.sessionId || ""); if (!sessionId) return res.status(400).json({ error: "sessionId required" }); try { res.json(await worldModel.snapshot(sessionId)); } catch (error) { res.status(500).json({ error: error.message }); } });
app.get("/api/memory", async (req, res) => { const sessionId = String(req.query.sessionId || ""); if (!sessionId) return res.status(400).json({ error: "sessionId required" }); try { res.json(await memory.recall(sessionId, String(req.query.q || ""), 50)); } catch (error) { res.status(500).json({ error: error.message }); } });

app.post("/api/chat", async (req, res) => {
  const sessionId = String(req.body?.sessionId || "").trim(); const message = String(req.body?.message || "").trim(); const approvalToken = req.body?.approvalToken || null;
  if (!sessionId || !message) return res.status(400).json({ error: "sessionId and message required" });
  try {
    await selfModel.ensure(sessionId); await hydrateSessionCapabilities(sessionId);
    const result = await cortex.run({ session: { id: sessionId }, userText: message, approvalToken });
    res.json({ ok: true, message: result.message || "", decision: result.decision, confidence: result.confidence, tool_calls: result.tool_calls || [], observations: result.observations || [], learning: result.learning || null });
  } catch (error) { console.error("Cortex failure:", error); res.status(500).json({ ok: false, error: "Cognitive cycle failed", detail: error.message }); }
});

const port = process.env.PORT || 3000; app.listen(port, () => console.log(`JARVIS cognitive core listening on ${port}`));
