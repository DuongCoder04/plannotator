import { describe, expect, test } from "bun:test";
import { tool } from "@opencode-ai/plugin";
import PlannotatorPlugin from "./index";

describe("OpenCode 1 submit_plan argument validation", () => {
  test.each([{}, { edits: [] }])("returns a recoverable error for %j", async (input) => {
    const plugin = await PlannotatorPlugin({
      client: {},
      directory: "/workspace/example",
    } as never, { workflow: "all-agents" } as never);
    const submitPlan = plugin.tool?.submit_plan;
    if (!submitPlan) throw new Error("submit_plan was not registered");

    // Parse with the registered schema before executing, like the host does.
    const args = tool.schema.object(submitPlan.args).parse(input);
    const result = await submitPlan.execute(args, {
      sessionID: "session-missing-edits",
      messageID: "message-1",
      agent: "plan",
      directory: "/workspace/example",
      worktree: "/workspace/example",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    });

    expect(result).toContain("Error: No edits provided");
    expect(result).toContain("start and content");
    expect(tool.schema.object(submitPlan.args).safeParse({
      edits: [{ start: 1 }],
    }).success).toBe(false);
  });
});
