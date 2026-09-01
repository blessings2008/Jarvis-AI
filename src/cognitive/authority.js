const LEVELS = { low: 0, medium: 1, high: 2, critical: 3 };

class Authority {
  constructor({ defaultApproval = "medium" } = {}) { this.defaultApproval = defaultApproval; }

  requiredRisk(tool = {}) { return tool.risk || "unknown"; }

  async authorize(tool, args, context = {}) {
    const risk = this.requiredRisk(tool);
    const level = LEVELS[risk] ?? LEVELS[this.defaultApproval];
    if (level <= LEVELS.low) return { allowed: true, risk };
    if (context.approvalToken && context.approvalToken === `approved:${tool.name}`) return { allowed: true, risk, approved: true };
    return { allowed: false, risk, status: "permission_required", reason: `${risk}-risk capability requires explicit approval` };
  }
}

module.exports = { Authority, LEVELS };
