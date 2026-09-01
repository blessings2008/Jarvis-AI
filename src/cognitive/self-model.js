const DEFAULT_SELF = {
  identity: { name: "JARVIS", version: "1.0-cognitive" },
  state: "idle",
  goals: [],
  known_capabilities: [],
  learned_capabilities: [],
  limitations: [],
  current_focus: null,
  confidence: 0.5,
  successes: 0,
  failures: 0,
  lessons: [],
  last_reflection: null
};

class SelfModel {
  constructor(supabase) { this.db = supabase; }

  async snapshot(sessionId) {
    const { data, error } = await this.db.from("jarvis_self_model").select("model").eq("session_id", sessionId).maybeSingle();
    if (error) throw error;
    return { ...DEFAULT_SELF, ...(data?.model || {}) };
  }

  async ensure(sessionId) {
    const existing = await this.snapshot(sessionId);
    const { error } = await this.db.from("jarvis_self_model").upsert({ session_id: sessionId, model: existing, updated_at: new Date().toISOString() });
    if (error) throw error;
    return existing;
  }

  async update(sessionId, update) {
    const model = await this.snapshot(sessionId);
    const field = String(update.field || "").trim();
    if (!field || field.includes("__") || !Object.prototype.hasOwnProperty.call(model, field)) return model;
    model[field] = update.value;
    model.last_reflection = new Date().toISOString();
    return this.persist(sessionId, model);
  }

  async reflect(sessionId, { goal, success, lesson, observations = [] }) {
    const model = await this.snapshot(sessionId);
    model.state = "idle";
    model.current_focus = null;
    model.goals = (model.goals || []).filter(g => g !== goal).slice(-20);
    if (success) model.successes = Number(model.successes || 0) + 1;
    else if (success === false) model.failures = Number(model.failures || 0) + 1;
    const total = model.successes + model.failures;
    if (total) model.confidence = Math.max(0, Math.min(1, model.successes / total));
    if (lesson) model.lessons = [...(model.lessons || []), lesson].slice(-20);
    const failedTools = observations.filter(o => o?.result?.ok === false).map(o => o.tool);
    if (failedTools.length) model.limitations = [...new Set([...(model.limitations || []), ...failedTools])].slice(-30);
    model.last_reflection = new Date().toISOString();
    return this.persist(sessionId, model);
  }

  async persist(sessionId, model) {
    const { error } = await this.db.from("jarvis_self_model").upsert({ session_id: sessionId, model, updated_at: new Date().toISOString() });
    if (error) throw error;
    return model;
  }
}

module.exports = { SelfModel, DEFAULT_SELF };
