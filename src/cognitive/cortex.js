const DEFAULT_MAX_STEPS = 8;

function safeJson(value) {
  try { return JSON.stringify(value); } catch { return "null"; }
}

/**
 * The Cortex owns interpretation, planning, tool selection and reflection.
 * It does not contain a fixed list of user commands. Tools are supplied as
 * capabilities discovered from the current environment.
 */
class Cortex {
  constructor({ model, client, memory, selfModel, tools, maxSteps = DEFAULT_MAX_STEPS }) {
    this.model = model;
    this.client = client;
    this.memory = memory;
    this.selfModel = selfModel;
    this.tools = tools;
    this.maxSteps = maxSteps;
  }

  toolManifest() {
    return this.tools.list().map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters || {},
      risk: t.risk || "unknown"
    }));
  }

  systemPrompt() {
    return `You are JARVIS, a persistent agent. You are not a command matcher.
Your job is to understand the user's underlying objective, reason about it, decide what should happen next, and use available capabilities when useful.

IMPORTANT:
- Never claim a capability exists unless it appears in the capability manifest.
- An unfamiliar request is not automatically impossible. Decompose it, reason about available capabilities, and determine whether it can be achieved indirectly.
- Do not confuse lack of knowledge with lack of capability.
- Maintain uncertainty honestly.
- You may propose multi-step plans.
- Tool execution is performed outside the model. Return structured decisions.
- Permissions are authority boundaries, not reasoning boundaries.
- Learn from outcomes. If a procedure works, record it. If it fails, diagnose why and adapt.
- Do not pretend to be conscious. You maintain a self-model describing your state, knowledge, capabilities and limitations.

Return ONLY valid JSON with this shape:
{
  "thought_summary": "brief reasoning summary",
  "decision": "respond|act|ask|learn|finish",
  "message": "user-facing response",
  "tool_calls": [{"name":"tool_name","arguments":{}}],
  "memory_candidates": [{"kind":"fact|episode|procedure|preference","content":"..."}],
  "self_updates": [{"field":"...","value":"..."}],
  "confidence": 0.0
}`;
  }

  async decide({ session, userText, observations = [] }) {
    const memories = await this.memory.recall(session.id, userText);
    const self = await this.selfModel.snapshot(session.id);
    const context = {
      user: userText,
      recent_observations: observations.slice(-8),
      memories: memories.slice(0, 12),
      self_model: self,
      capabilities: this.toolManifest()
    };

    const completion = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: this.systemPrompt() },
        { role: "user", content: safeJson(context) }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content || "{}";
    let result;
    try { result = JSON.parse(raw); } catch { result = { decision: "respond", message: raw, tool_calls: [] }; }
    result.tool_calls = Array.isArray(result.tool_calls) ? result.tool_calls : [];
    result.memory_candidates = Array.isArray(result.memory_candidates) ? result.memory_candidates : [];
    result.self_updates = Array.isArray(result.self_updates) ? result.self_updates : [];
    result.confidence = Number.isFinite(result.confidence) ? result.confidence : 0.5;
    return result;
  }

  async run({ session, userText }) {
    const observations = [];
    const decisions = [];

    for (let step = 0; step < this.maxSteps; step++) {
      const decision = await this.decide({ session, userText, observations });
      decisions.push(decision);

      for (const candidate of decision.memory_candidates) {
        await this.memory.remember(session.id, candidate);
      }
      for (const update of decision.self_updates) {
        await this.selfModel.update(session.id, update);
      }

      if (decision.decision !== "act" || !decision.tool_calls.length) {
        return { ...decision, decisions, observations };
      }

      for (const call of decision.tool_calls) {
        const result = await this.tools.execute(call.name, call.arguments || {}, { session });
        observations.push({
          step,
          tool: call.name,
          arguments: call.arguments || {},
          result
        });
      }
    }

    return {
      decision: "respond",
      message: "I reached the execution limit before completing the task. I have preserved what I learned from the attempts.",
      tool_calls: [],
      decisions,
      observations
    };
  }
}

module.exports = { Cortex };
