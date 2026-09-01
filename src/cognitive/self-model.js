const DEFAULT_SELF = {
  identity: { name: "JARVIS", version: "1.0-cognitive" },
  state: "idle",
  goals: [],
  known_capabilities: [],
  learned_capabilities: [],
  limitations: [],
  current_focus: null,
  confidence: 0.5,
  last_reflection: null
};

class SelfModel {
  constructor(supabase) { this.db = supabase; }

  async snapshot(sessionId) {
    const { data, error } = await this.db.from("jarvis_self_model").select("model").eq("session_id", sessionId).maybeSingle();
    if (error) throw error;
    return data?.model || DEFAULT_SELF;
  }

  async ensure(sessionId) {
    const existing = await this.snapshot(sessionId);
    const { error } = await this.db.from("jarvis_self_model").upsert({
      session_id: sessionId,
      model: existing,
      updated_at: new Date().toISOString()
    });
    if (error) throw error;
    return existing;
  }

  async update(sessionId, update) {
    const model = await this.snapshot(sessionId);
    const field = String(update.field || "").trim();
    if (!field || field.includes("__")) return model;
    // Only allow top-level self-model fields; arbitrary database paths are not accepted.
    if (!Object.prototype.hasOwnProperty.call(model, field)) return model;
    model[field] = update.value;
    model.last_reflection = new Date().toISOString();
    const { error } = await this.db.from("jarvis_self_model").upsert({ session_id: sessionId, model, updated_at: new Date().toISOString() });
    if (error) throw error;
    return model;
  }
}

module.exports = { SelfModel, DEFAULT_SELF };
