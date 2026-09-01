class ToolRegistry {
  constructor() { this.tools = new Map(); }

  key(sessionId, name) { return `${sessionId}:${name}`; }

  register(sessionId, tool) {
    if (!sessionId || !tool?.name || typeof tool.execute !== "function") throw new Error("Invalid session-scoped tool definition");
    const value = Object.freeze({ ...tool, sessionId });
    this.tools.set(this.key(sessionId, tool.name), value);
    return value;
  }

  unregister(sessionId, name) { return this.tools.delete(this.key(sessionId, name)); }
  get(sessionId, name) { return this.tools.get(this.key(sessionId, name)); }
  list(sessionId) { return [...this.tools.values()].filter(t => t.sessionId === sessionId); }

  async execute(name, args, context = {}) {
    const sessionId = context.session?.id;
    const tool = this.get(sessionId, name);
    if (!tool) return { ok: false, error: `Unknown capability: ${name}` };

    if (tool.authorize) {
      const authorization = await tool.authorize(args, context);
      if (authorization !== true && authorization?.allowed !== true) {
        return {
          ok: false,
          status: "permission_required",
          risk: authorization?.risk || tool.risk || "unknown",
          error: authorization?.reason || `Permission required for ${name}`
        };
      }
    }

    try {
      return { ok: true, result: await tool.execute(args, context) };
    } catch (error) {
      return { ok: false, error: error.message, retryable: Boolean(error.retryable) };
    }
  }
}

module.exports = { ToolRegistry };
