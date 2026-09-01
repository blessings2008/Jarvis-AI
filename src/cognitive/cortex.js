const DEFAULT_MAX_STEPS = 8;
function safeJson(value) { try { return JSON.stringify(value); } catch { return "null"; } }

class Cortex {
  constructor({ model, client, memory, selfModel, tools, worldModel, procedures, learning, capabilityAcquisition = null, maxSteps = DEFAULT_MAX_STEPS }) {
    this.model = model; this.client = client; this.memory = memory; this.selfModel = selfModel; this.tools = tools; this.worldModel = worldModel; this.procedures = procedures; this.learning = learning; this.capabilityAcquisition = capabilityAcquisition; this.maxSteps = maxSteps;
  }

  setCapabilityAcquisition(acquisition) { this.capabilityAcquisition = acquisition; return this; }

  toolManifest(sessionId) { return this.tools.list(sessionId).map(t => ({ name: t.name, description: t.description, parameters: t.parameters || {}, risk: t.risk || "unknown" })); }

  systemPrompt() {
    return `You are JARVIS, a persistent cognitive agent. You are not a command matcher.
Understand the user's underlying objective, reason about it, plan, select capabilities, act, inspect results, and adapt.
Rules:
- Never claim a capability exists unless it appears in the manifest.
- An unfamiliar request is not automatically impossible. Decompose it and investigate available capabilities.
- If the goal requires discovering a new route from existing capabilities, choose decision "learn" rather than pretending the route is known.
- A learned procedure is a hypothesis, not truth. Reuse it only when it matches the goal and available capabilities.
- Treat procedures marked recommendation "avoid" as unsafe to reuse unless a genuinely different route is unavailable.
- Treat procedures marked "revise_or_verify" as unreliable: change the approach, add verification, or use another route.
- Use procedure reliability and failure history when choosing between otherwise similar routes.
- Do not confuse lack of knowledge with lack of capability.
- Maintain uncertainty honestly and do not pretend to be conscious.
- Permissions are authority boundaries, not reasoning boundaries. You may reason about restricted actions, but execution may require approval.
- After observations, decide whether to continue, replan, ask, or finish.
- Do not blindly repeat a failed action; change the approach or explain the blocker.
Return ONLY valid JSON: {"thought_summary":"brief reasoning","decision":"respond|act|ask|learn|finish","message":"user-facing response","tool_calls":[{"name":"tool","arguments":{}}],"memory_candidates":[{"kind":"fact|episode|procedure|preference","content":"..."}],"self_updates":[{"field":"...","value":"..."}],"confidence":0.0}`;
  }

  async decide({ session, userText, observations = [] }) {
    const memories = await this.memory.recall(session.id, userText);
    const self = await this.selfModel.snapshot(session.id);
    const world = await this.worldModel.snapshot(session.id);
    const procedures = await this.procedures.search(session.id, userText);
    const context = { user: userText, recent_observations: observations.slice(-8), memories: memories.slice(0, 12), self_model: self, world_model: world, learned_procedures: procedures, capabilities: this.toolManifest(session.id) };
    const completion = await this.client.chat.completions.create({ model: this.model, temperature: 0.2, response_format: { type: "json_object" }, messages: [{ role: "system", content: this.systemPrompt() }, { role: "user", content: safeJson(context) }] });
    const raw = completion.choices?.[0]?.message?.content || "{}";
    let result; try { result = JSON.parse(raw); } catch { result = { decision: "respond", message: raw, tool_calls: [] }; }
    result.tool_calls = Array.isArray(result.tool_calls) ? result.tool_calls : [];
    result.memory_candidates = Array.isArray(result.memory_candidates) ? result.memory_candidates : [];
    result.self_updates = Array.isArray(result.self_updates) ? result.self_updates : [];
    result.confidence = Number.isFinite(result.confidence) ? result.confidence : 0.5;
    return result;
  }

  async run({ session, userText, approvalToken = null }) {
    const observations = [], decisions = [];
    let acquisitionUsed = false;
    for (let step = 0; step < this.maxSteps; step++) {
      const decision = await this.decide({ session, userText, observations }); decisions.push(decision);
      for (const candidate of decision.memory_candidates) await this.memory.remember(session.id, candidate);
      for (const update of decision.self_updates) await this.selfModel.update(session.id, update);

      if (decision.decision === "learn" && this.capabilityAcquisition && !acquisitionUsed) {
        acquisitionUsed = true;
        const acquisition = await this.capabilityAcquisition.acquire({ session, goal: userText, approvalToken });
        observations.push({ step, type: "capability_acquisition", result: acquisition });
        if (acquisition.approval_required || !acquisition.acquired) {
          const learning = await this.learning.learnFromOutcome(session.id, { goal: userText, plan: decisions.map(d => d.tool_calls || []), observations, outcome: false });
          return { decision: acquisition.approval_required ? "ask" : "respond", message: acquisition.approval_required ? "I found a route, but one or more capabilities require your approval before I can execute it." : "I could not discover a reliable route for that task yet, but I preserved what I learned.", tool_calls: [], decisions, observations, learning };
        }
        continue;
      }

      if (decision.decision !== "act" || !decision.tool_calls.length) {
        const outcome = decision.decision === "finish" ? true : null;
        const learning = await this.learning.learnFromOutcome(session.id, { goal: userText, plan: decisions.map(d => d.tool_calls || []), observations, outcome });
        return { ...decision, decisions, observations, learning };
      }
      let blocked = false;
      for (const call of decision.tool_calls) {
        const result = await this.tools.execute(call.name, call.arguments || {}, { session, cycle: step, goal: userText, approvalToken });
        observations.push({ step, tool: call.name, arguments: call.arguments || {}, result });
        if (result.status === "permission_required") blocked = true;
      }
      await this.worldModel.observe(session.id, { environment: { last_cycle: step, last_observations: observations.slice(-8) } });
      if (blocked) break;
    }
    const learning = await this.learning.learnFromOutcome(session.id, { goal: userText, plan: decisions.map(d => d.tool_calls || []), observations, outcome: false });
    return { decision: "respond", message: "I could not safely complete the task within the current execution cycle. I preserved the observations for future reasoning.", tool_calls: [], decisions, observations, learning };
  }
}
module.exports = { Cortex };
