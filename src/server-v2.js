require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Groq = require("groq-sdk");
const { createClient } = require("@supabase/supabase-js");
const { Cortex } = require("./cognitive/cortex");
const { Memory } = require("./cognitive/memory");
const { SelfModel } = require("./cognitive/self-model");
const { ToolRegistry } = require("./cognitive/tool-registry");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const tools = new ToolRegistry();
const memory = new Memory(supabase);
const selfModel = new SelfModel(supabase);
const cortex = new Cortex({
  model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
  client: groq,
  memory,
  selfModel,
  tools
});

// The server only exposes capabilities. The Android client remains the body.
// A device tool is registered when the client sends its current capability manifest.
app.post("/api/capabilities", async (req, res) => {
  const incoming = Array.isArray(req.body?.capabilities) ? req.body.capabilities : [];
  for (const capability of incoming) {
    if (!capability?.name) continue;
    tools.register({
      name: capability.name,
      description: capability.description || "Device capability",
      parameters: capability.parameters || {},
      risk: capability.risk || "unknown",
      // Server returns an execution intent. Android executes it after its own authority check.
      execute: async (args) => ({ dispatch: true, name: capability.name, arguments: args })
    });
  }
  res.json({ ok: true, capabilities: tools.list().map(t => ({ name: t.name, description: t.description, parameters: t.parameters, risk: t.risk })) });
});

app.get("/api/health", async (_req, res) => {
  const { error } = await supabase.from("jarvis_sessions").select("session_id").limit(1);
  res.json({ ok: true, brain: "cognitive", database: error ? "unreachable" : "connected", capabilities: tools.list().length });
});

app.get("/api/self", async (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  res.json(await selfModel.ensure(sessionId));
});

app.get("/api/memory", async (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  res.json(await memory.recall(sessionId, String(req.query.q || ""), 50));
});

app.post("/api/chat", async (req, res) => {
  const sessionId = String(req.body?.sessionId || "").trim();
  const message = String(req.body?.message || "").trim();
  if (!sessionId || !message) return res.status(400).json({ error: "sessionId and message required" });

  try {
    await selfModel.ensure(sessionId);
    const result = await cortex.run({ session: { id: sessionId }, userText: message });
    res.json({
      ok: true,
      message: result.message || "",
      decision: result.decision,
      confidence: result.confidence,
      tool_calls: result.tool_calls || [],
      observations: result.observations || []
    });
  } catch (error) {
    console.error("Cortex failure:", error);
    res.status(500).json({ ok: false, error: "Cognitive cycle failed", detail: error.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`JARVIS cognitive core listening on ${port}`));
