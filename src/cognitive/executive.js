class Executive {
  constructor({ cortex, learning, selfModel, maxCycles = 12 }) {
    this.cortex = cortex;
    this.learning = learning;
    this.selfModel = selfModel;
    this.maxCycles = maxCycles;
  }

  async run({ session, userText }) {
    const observations = [];
    const decisions = [];
    let finalDecision = null;

    for (let cycle = 0; cycle < this.maxCycles; cycle++) {
      const decision = await this.cortex.decide({ session, userText, observations });
      decisions.push(decision);
      finalDecision = decision;

      for (const candidate of decision.memory_candidates || []) {
        await this.cortex.memory.remember(session.id, candidate);
      }
      for (const update of decision.self_updates || []) {
        await this.selfModel.update(session.id, update);
      }

      if (decision.decision !== "act" || !(decision.tool_calls || []).length) break;

      for (const call of decision.tool_calls) {
        const result = await this.cortex.tools.execute(call.name, call.arguments || {}, {
          session,
          cycle,
          goal: userText
        });
        observations.push({ cycle, tool: call.name, arguments: call.arguments || {}, result });
      }
    }

    const outcome = this.inferOutcome(finalDecision, observations);
    const learning = await this.learning.learnFromOutcome(session.id, {
      goal: userText,
      plan: decisions.map(d => d.tool_calls || []),
      observations,
      outcome
    });

    return { ...finalDecision, decisions, observations, learning };
  }

  inferOutcome(decision, observations) {
    if (observations.some(o => o.result?.ok === false)) return false;
    if (["finish", "respond"].includes(decision?.decision)) return true;
    return observations.length === 0 ? null : true;
  }
}

module.exports = { Executive };
