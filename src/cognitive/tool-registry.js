class ToolRegistry {
  constructor() { this.tools = new Map(); }

  register(tool) {
    if (!tool?.name || typeof tool.execute !== "function") throw new Error("Invalid tool definition");
    this.tools.set(tool.name, Object.freeze({ ...tool }));
    return this.tools.get(tool.name);
  }

  unregister(name) { return this.tools.delete(name); }
  get(name) { return this.tools.get(name); }
  list() { return [...this.tools.values()]; }

  async execute(name, args, context) {
    const tool = this.get(name);
    if (!tool) return { ok: false, error: `Unknown capability: ${name}` };
    if (tool.authorize && !(await tool.authorize(args, context))) {
      return { ok: false, status: "permission_required", error: `Permission required for ${name}` };
    }
    try {
      const result = await tool.execute(args, context);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error.message, retryable: Boolean(error.retryable) };
    }
  }
}

module.exports = { ToolRegistry };
