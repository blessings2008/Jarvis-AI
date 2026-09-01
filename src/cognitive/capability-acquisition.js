const DEFAULT_MAX_ATTEMPTS = 4;

/**
 * Capability acquisition discovers and evaluates a candidate route. It never
 * executes action tools while investigating, preventing discovery from
 * causing side effects or executing the same route twice.
 */
class CapabilityAcquisition {
  constructor({ cortex, tools, procedures, maxAttempts = DEFAULT_MAX_ATTEMPTS }) {
    this.cortex = cortex;
    this.tools = tools;
    this.procedures = procedures;
    this.maxAttempts = maxAttempts;
  }

  async investigate({ session, goal, observations = [] }) {
    const decision = await this.cortex.decide({ session, userText: goal, observations });
    const route = Array.isArray(decision.tool_calls) ? decision.tool_calls : [];
    const capabilities = this.cortex.toolManifest(session.id);
    const available = new Set(capabilities.map(capability => capability.name));
    const invalid = route.filter(call => !available.has(call?.name));

    return {
      decision,
      route,
      capabilities,
      learned_procedures: await this.procedures.search(session.id, goal),
      valid_route: route.length > 0 && invalid.length === 0,
      invalid_calls: invalid
    };
  }

  async acquire({ session, goal }) {
    const observations = [];
    const decisions = [];

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const investigation = await this.investigate({ session, goal, observations });
      decisions.push(investigation.decision);

      if (!investigation.valid_route) {
        observations.push({
          attempt,
          type: "route_validation",
          valid: false,
          invalid_calls: investigation.invalid_calls,
          reason: investigation.route.length ? "route contains unavailable capabilities" : "no executable route discovered"
        });
        continue;
      }

      return {
        acquired: true,
        reason: "route discovered and validated against the current capability manifest",
        observations,
        decisions,
        route: investigation.route,
        learning_recorded: false,
        requires_execution: true
      };
    }

    return {
      acquired: false,
      reason: "no valid route found",
      observations,
      decisions,
      learning_recorded: false,
      requires_execution: false
    };
  }
}

module.exports = { CapabilityAcquisition };
