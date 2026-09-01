class WorldModel {
  constructor(db) { this.db = db; }

  async snapshot(sessionId) {
    const { data, error } = await this.db.from("jarvis_world_state").select("state,updated_at").eq("session_id", sessionId).maybeSingle();
    if (error) throw error;
    return data?.state || { devices: [], apps: [], services: [], resources: [], environment: {} };
  }

  async observe(sessionId, observation = {}) {
    const current = await this.snapshot(sessionId);
    const next = {
      ...current,
      ...observation,
      environment: { ...(current.environment || {}), ...(observation.environment || {}) }
    };
    const { error } = await this.db.from("jarvis_world_state").upsert({ session_id: sessionId, state: next, updated_at: new Date().toISOString() });
    if (error) throw error;
    return next;
  }

  async registerDevice(sessionId, device) {
    const current = await this.snapshot(sessionId);
    const devices = (current.devices || []).filter(d => d.id !== device.id);
    devices.push({ ...device, observed_at: new Date().toISOString() });
    return this.observe(sessionId, { devices });
  }

  async registerCapabilities(sessionId, capabilities) {
    return this.observe(sessionId, { capabilities: capabilities || [] });
  }
}

module.exports = { WorldModel };
