class Memory {
  constructor(supabase) { this.db = supabase; }

  async remember(sessionId, item) {
    const kind = ["fact", "episode", "procedure", "preference"].includes(item.kind) ? item.kind : "fact";
    const content = String(item.content || "").trim();
    if (!content) return null;
    const row = { session_id: sessionId, kind, content, metadata: item.metadata || {}, created_at: new Date().toISOString() };
    const { data, error } = await this.db.from("jarvis_memory").insert(row).select().single();
    if (error) throw error;
    return data;
  }

  async recall(sessionId, query, limit = 12) {
    // Phase 1 intentionally uses recent memory. A vector index can be added
    // later without changing the Cortex interface.
    const { data, error } = await this.db.from("jarvis_memory")
      .select("id,kind,content,metadata,created_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(Math.max(limit * 3, 30));
    if (error) throw error;
    const words = String(query || "").toLowerCase().split(/\\W+/).filter(Boolean);
    return (data || []).sort((a,b) => score(b, words) - score(a, words)).slice(0, limit);
  }
}

function score(item, words) {
  if (!words.length) return 0;
  const text = `${item.kind} ${item.content}`.toLowerCase();
  return words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
}

module.exports = { Memory };
