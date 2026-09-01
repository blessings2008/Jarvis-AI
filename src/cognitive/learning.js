class LearningEngine {
  constructor({ db, memory, selfModel, procedures }) {
    this.db = db;
    this.memory = memory;
    this.selfModel = selfModel;
    this.procedures = procedures;
  }

  async recordExperience(sessionId, experience) {
    const row = {
      session_id: sessionId,
      goal: String(experience.goal || "").trim(),
      plan: experience.plan || [],
      observations: experience.observations || [],
      outcome: experience.outcome == null ? null : String(experience.outcome),
      lesson: experience.lesson || null
    };
    if (!row.goal) return null;
    const { data, error } = await this.db.from("jarvis_experiences").insert(row).select().single();
    if (error) throw error;
    return data;
  }

  async learnFromOutcome(sessionId, { goal, plan, observations, outcome, procedureId = null }) {
    const success = this.isSuccessful(outcome, observations);
    const lesson = this.extractLesson(goal, plan, observations, outcome, success);
    const experience = await this.recordExperience(sessionId, { goal, plan, observations, outcome, lesson });

    if (lesson) {
      await this.memory.remember(sessionId, { kind: "episode", content: lesson, metadata: { goal, success } });
    }

    if (procedureId) {
      await this.procedures.recordOutcome(procedureId, success);
    } else if (success && this.hasExecutablePlan(plan)) {
      await this.procedures.save(sessionId, {
        name: this.procedureName(goal), goal, steps: this.flattenPlan(plan), confidence: 0.6
      });
    }

    await this.selfModel.reflect(sessionId, { goal, success, lesson, observations });
    return { success, lesson, experience };
  }

  hasExecutablePlan(plan) {
    return Array.isArray(plan) && plan.some(cycle => Array.isArray(cycle) && cycle.some(call => call?.name));
  }

  flattenPlan(plan) {
    return (plan || []).flatMap(cycle => Array.isArray(cycle) ? cycle : []).map(call => ({ name: call.name, arguments: call.arguments || {} }));
  }

  procedureName(goal) {
    return String(goal || "learned-task").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "learned-task";
  }

  isSuccessful(outcome, observations = []) {
    if (typeof outcome === "boolean") return outcome;
    if (observations.some(o => o?.result?.ok === false)) return false;
    return /success|complete|done|worked/i.test(String(outcome || ""));
  }

  extractLesson(goal, plan, observations, outcome, success) {
    if (!goal) return null;
    if (success) return `Successful experience for goal: ${goal}. Reusable procedure contains ${this.flattenPlan(plan).length} action(s).`;
    const failed = (observations || []).filter(o => o?.result?.ok === false);
    if (!failed.length) return `Incomplete experience for goal: ${goal}. Outcome: ${String(outcome || "unknown")}`;
    return `Failed experience for goal: ${goal}. Failed capability: ${failed.map(x => x.tool).join(", ")}. Errors: ${failed.map(x => x.result?.error || "unknown").join(" | ")}`;
  }
}

module.exports = { LearningEngine };
