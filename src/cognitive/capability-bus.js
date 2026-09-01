class CapabilityBus {
  constructor(db) { this.db = db; }

  async register(sessionId, capability) {
    if (!sessionId || !capability?.name) throw new Error("sessionId and capability.name are required");
    const row = { session_id: sessionId, name: String(capability.name), description: String(capability.description || ""), parameters: capability.parameters || {}, risk: capability.risk || "unknown", source: capability.source || "device", version: capability.version || 1, enabled: true, updated_at: new Date().toISOString() };
    const { data, error } = await this.db.from("jarvis_capabilities").upsert(row, { onConflict: "session_id,name" }).select().single();
    if (error) throw error;
    return data;
  }

  async list(sessionId) {
    const { data, error } = await this.db.from("jarvis_capabilities").select("name,description,parameters,risk,source,version,enabled").eq("session_id", sessionId).eq("enabled", true);
    if (error) throw error;
    return data || [];
  }

  async disable(sessionId, name) {
    const { error } = await this.db.from("jarvis_capabilities").update({ enabled: false, updated_at: new Date().toISOString() }).eq("session_id", sessionId).eq("name", name);
    if (error) throw error;
  }
}

module.exports = { CapabilityBus };
