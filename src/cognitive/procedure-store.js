class ProcedureStore {
  constructor(db) { this.db = db; }

  async search(sessionId, goal) {
    const { data, error } = await this.db.from("jarvis_procedures").select("id,name,goal,steps,confidence,success_count,failure_count,status,updated_at").eq("session_id", sessionId).eq("status", "active").order("confidence", { ascending: false }).limit(20);
    if (error) throw error;
    const terms = String(goal || "").toLowerCase().split(/\\W+/).filter(Boolean);
    return (data || []).filter(p => terms.length === 0 || terms.some(t => String(p.goal || "").toLowerCase().includes(t) || String(p.name || "").toLowerCase().includes(t))).slice(0, 8);
  }

  async save(sessionId, procedure) {
    const row = { session_id: sessionId, name: String(procedure.name || "learned-procedure"), goal: String(procedure.goal || ""), steps: procedure.steps || [], confidence: Number(procedure.confidence ?? 0.6), success_count: 1, failure_count: 0, status: "active" };
    const { data, error } = await this.db.from("jarvis_procedures").insert(row).select().single();
    if (error) throw error;
    return data;
  }

  async recordOutcome(id, success) {
    const { data: current, error: readError } = await this.db.from("jarvis_procedures").select("success_count,failure_count,confidence").eq("id", id).single();
    if (readError) throw readError;
    const successCount = current.success_count + (success ? 1 : 0);
    const failureCount = current.failure_count + (success ? 0 : 1);
    const total = successCount + failureCount;
    const confidence = Math.max(0, Math.min(1, successCount / total));
    const status = failureCount >= 3 && confidence < 0.4 ? "retired" : "active";
    const { data, error } = await this.db.from("jarvis_procedures").update({ success_count: successCount, failure_count: failureCount, confidence, status, updated_at: new Date().toISOString() }).eq("id", id).select().single();
    if (error) throw error;
    return data;
  }
}

module.exports = { ProcedureStore };
