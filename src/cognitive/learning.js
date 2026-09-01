class LearningEngine {
  constructor({ db, memory, selfModel }) {
    this.db = db;
    this.memory = memory;
    this.selfModel = selfModel;
  }

  async recordExperience(sessionId, experience) {
    const row = {
      session_id: sessionId,
      goal: String(experience.goal || "").trim(),
      plan: experience.plan || [],
      observations: experience.observations || [],
      outcome: experience.outcome || null,
      lesson: experience.lesson || null
    };
    if (!row.goal) return null;
    const { data, error } = await this.db.from("jarvis_experiences").insert(row).select().single();
    if (error) throw error;
    return data;
  }

  async learnFromOutcome(sessionId, { goal, plan, observations, outcome }) {
    const success = this.isSuccessful(outcome, observations);
    const lesson = this.extractLesson(goal, plan, observations, outcome, success);
    const experience = await this.recordExperience(sessionId, {
      goal, plan, observations, outcome, lesson
    });

    if (lesson) {
      await this.memory.remember(sessionId, {
        kind: "episode",
        content: lesson,
        metadata: { goal, success }
      });
    }

    if (success && plan?.length) {
      await this.memory.remember(sessionId, {
        kind: "procedure",
        content: JSON.stringify({ goal, procedure: plan }),
        metadata: { learned: true, confidence: 0.6 }
      });
    }

    return { success, lesson, experience };
  }

  isSuccessful(outcome, observations = []) {
    if (typeof outcome === "boolean") return outcome;
    const failures = observations.filter(o => o?.result?.ok === false);
    if (failures.length) return false;
    return String(outcome || "").toLowerCase().match(/success|complete|done|worked/) !== null;
  }

  extractLesson(goal, plan, observations, outcome, success) {
    if (!goal) return null;
    if (success) return `Successful experience for goal: ${goal}. Procedure: ${JSON.stringify(plan || [])}`;
    const failed = (observations || []).filter(o => o?.result?.ok === false);
    if (!failed.length) return `Incomplete experience for goal: ${goal}. Outcome: ${String(outcome || "unknown")}`;
    return `Failed experience for goal: ${goal}. Failed capability: ${failed.map(x => x.tool).join(", ")}. Errors: ${failed.map(x => x.result?.error || "unknown").join(" | ")}`;
  }
}

module.exports = { LearningEngine };
