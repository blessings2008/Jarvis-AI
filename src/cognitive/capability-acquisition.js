const DEFAULT_MAX_ATTEMPTS = 4;

/**
 * Discovers a route without claiming that discovery itself completed the
 * user's goal. The normal Cortex loop owns final execution and learning.
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
        return { acquired: false, reason: "no executable route discovered", observations, decisions, learning_recorded: false };
      }

      let blocked = false;
      let useful = false;
      for (const call of decision.tool_calls) {
        const result = await this.tools.execute(call.name, call.arguments || {}, {
          session, goal, cycle: attempt, approvalToken, acquisition: true, discovery: true
        });
        observations.push({ attempt, tool: call.name, arguments: call.arguments || {}, result });
        if (result.status === "permission_required") blocked = true;
        if (result.ok) useful = true;
      }

      if (blocked) {
        return { acquired: false, reason: "approval required", observations, decisions, approval_required: true, learning_recorded: false };
      }

      if (useful && observations.every(o => o.result?.ok !== false)) {
        return {
          acquired: true,
          reason: "route discovered and tested",
          observations,
          decisions,
          route: decisions.at(-1)?.tool_calls || [],
          learning_recorded: false
        };
      }
    }

    return { acquired: false, reason: "no reliable route found", observations, decisions, learning_recorded: false };
  }
}

module.exports = { CapabilityAcquisition };
