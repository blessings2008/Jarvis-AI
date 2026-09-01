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
    const { data, error } = await this.db.from("jarvis_memory")
      .select("id,kind,content,metadata,created_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(Math.max(limit * 5, 50));
    if (error) throw error;
    const words = [...new Set(String(query || "").toLowerCase().split(/\W+/).filter(w => w.length > 1))];
    const now = Date.now();
    return (data || [])
      .map(item => ({ ...item, relevance: score(item, words), recency: recency(item.created_at, now) }))
      .sort((a, b) => {
        const scoreA = a.relevance * 0.75 + a.recency * 0.25;
        const scoreB = b.relevance * 0.75 + b.recency * 0.25;
        return scoreB - scoreA;
      })
      .slice(0, limit);
  }
}

function score(item, words) {
  if (!words.length) return 0;
  const text = `${item.kind} ${item.content}`.toLowerCase();
  return words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0) / words.length;
}

function recency(createdAt, now) {
  const ageHours = Math.max(0, (now - new Date(createdAt).getTime()) / 3600000);
  return 1 / (1 + ageHours / 168);
}

module.exports = { Memory };
