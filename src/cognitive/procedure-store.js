class ProcedureStore {
  constructor(db) { this.db = db; }

  async search(sessionId, goal) {
    const { data, error } = await this.db.from("jarvis_procedures").select("id,name,goal,steps,confidence,success_count,failure_count,status,updated_at").eq("session_id", sessionId).order("updated_at", { ascending: false }).limit(100);
    if (error) throw error;
    const terms = [...new Set(String(goal || "").toLowerCase().split(/\W+/).filter(t => t.length > 1))];
    return (data || [])
      .map(p => {
        const haystack = `${p.goal || ""} ${p.name || ""}`.toLowerCase();
        const matches = terms.filter(t => haystack.includes(t)).length;
        const successes = Number(p.success_count || 0);
        const failures = Number(p.failure_count || 0);
        const total = successes + failures;
        const reliability = total ? successes / total : Number(p.confidence || 0);
        const failedRecently = failures > 0 && failures >= successes;
        return {
          ...p,
          relevance: terms.length ? matches / terms.length : 0,
          reliability,
          failed_recently: failedRecently,
          recommendation: p.status === "retired" ? "avoid" : failedRecently ? "revise_or_verify" : "consider"
        };
      })
      .filter(p => terms.length === 0 || p.relevance > 0)
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === "active" ? -1 : 1;
        const scoreA = a.relevance * 0.55 + a.reliability * 0.35 + Number(a.confidence || 0) * 0.1;
        const scoreB = b.relevance * 0.55 + b.reliability * 0.35 + Number(b.confidence || 0) * 0.1;
        return scoreB - scoreA;
      })
      .slice(0, 8);
  }

  async save(sessionId, procedure) {
    const name = String(procedure.name || "learned-procedure");
    const row = {
      session_id: sessionId,
      name,
      goal: String(procedure.goal || ""),
      steps: procedure.steps || [],
      confidence: Number(procedure.confidence ?? 0.6),
      updated_at: new Date().toISOString()
    };

    const { data: existing, error: readError } = await this.db.from("jarvis_procedures").select("id,success_count,failure_count,status").eq("session_id", sessionId).eq("name", name).maybeSingle();
    if (readError) throw readError;

    if (existing) {
      const { data, error } = await this.db.from("jarvis_procedures").update({
        goal: row.goal,
        steps: row.steps,
        confidence: row.confidence,
        status: existing.status === "retired" ? "active" : existing.status,
        updated_at: row.updated_at
      }).eq("id", existing.id).select().single();
      if (error) throw error;
      return data;
    }

    const { data, error } = await this.db.from("jarvis_procedures").insert({
      ...row,
      success_count: 1,
      failure_count: 0,
      status: "active"
    }).select().single();
    if (error) throw error;
    return data;
  }

  async recordOutcome(id, success) {
    const { data: current, error: readError } = await this.db.from("jarvis_procedures").select("success_count,failure_count,confidence").eq("id", id).single();
    if (readError) throw readError;
    const successCount = Number(current.success_count || 0) + (success ? 1 : 0);
    const failureCount = Number(current.failure_count || 0) + (success ? 0 : 1);
    const total = successCount + failureCount;
    const confidence = Math.max(0, Math.min(1, successCount / Math.max(1, total)));
    const status = failureCount >= 3 && confidence < 0.4 ? "retired" : "active";
    const { data, error } = await this.db.from("jarvis_procedures").update({ success_count: successCount, failure_count: failureCount, confidence, status, updated_at: new Date().toISOString() }).eq("id", id).select().single();
    if (error) throw error;
    return data;
  }
}

module.exports = { ProcedureStore };
