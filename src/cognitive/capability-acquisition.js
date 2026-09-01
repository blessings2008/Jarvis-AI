const DEFAULT_MAX_ATTEMPTS = 4;

/**
 * Capability acquisition is deliberately model-directed: the engine does not
 * contain a list of things JARVIS can learn. It gives the Cortex a structured
 * loop for discovering a route from an unknown goal to available primitives.
 */
class CapabilityAcquisition {
  constructor({ cortex, tools, procedures, learning, maxAttempts = DEFAULT_MAX_ATTEMPTS }) {
    this.cortex = cortex;
    this.tools = tools;
    this.procedures = procedures;
    this.learning = learning;
    this.maxAttempts = maxAttempts;
  }

  async investigate({ session, goal, observations = [] }) {
    const decision = await this.cortex.decide({ session, userText: goal, observations });
    return {
      decision,
      capabilities: this.cortex.toolManifest(session.id),
      learned_procedures: await this.procedures.search(session.id, goal)
    };
  }

  async acquire({ session, goal, approvalToken = null }) {
    const observations = [];
    const decisions = [];

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const investigation = await this.investigate({ session, goal, observations });
      const decision = investigation.decision;
      decisions.push(decision);

      if (!Array.isArray(decision.tool_calls) || decision.tool_calls.length === 0) {
        return { acquired: false, reason: "no executable route discovered", observations, decisions };
      }

      let blocked = false;
      let useful = false;
      for (const call of decision.tool_calls) {
        const result = await this.tools.execute(call.name, call.arguments || {}, {
          session, goal, cycle: attempt, approvalToken, acquisition: true
        });
        observations.push({ attempt, tool: call.name, arguments: call.arguments || {}, result });
        if (result.status === "permission_required") blocked = true;
        if (result.ok) useful = true;
      }

      if (blocked) {
        return { acquired: false, reason: "approval required", observations, decisions, approval_required: true };
      }

      if (useful && observations.every(o => o.result?.ok !== false)) {
        const learned = await this.learning.learnFromOutcome(session.id, {
          goal,
          plan: decisions.map(d => d.tool_calls || []),
          observations,
          outcome: true
        });
        return { acquired: true, reason: "successful route learned", observations, decisions, learned };
      }
    }

    const learned = await this.learning.learnFromOutcome(session.id, {
      goal,
      plan: decisions.map(d => d.tool_calls || []),
      observations,
      outcome: false
    });
    return { acquired: false, reason: "no reliable route found", observations, decisions, learned };
  }
}

module.exports = { CapabilityAcquisition };
