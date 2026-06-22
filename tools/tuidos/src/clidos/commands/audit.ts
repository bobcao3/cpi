import { defineCommand } from "citty";
import { collectAudit, parseLimit } from "../audit-view";
import { renderAuditTimeline } from "../format";

export const auditCommand = defineCommand({
  meta: { name: "audit", description: "View the global activity log" },
  args: {
    limit: {
      type: "string",
      alias: ["n"],
      description: "Max events to show (0 = all)",
      default: "50",
    },
  },
  run({ args }) {
    const limit = parseLimit(args.limit);
    console.log(renderAuditTimeline(collectAudit(limit, null), true));
  },
});
