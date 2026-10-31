/**
 * Pi plan and annotate servers: `/api/doc` outside the project (#2291). Same
 * scenarios as the Bun servers (packages/server/doc-any-path.scenarios.ts),
 * so the mirror cannot drift.
 */
import { defineDocAnyPathScenarios } from "../../../packages/server/doc-any-path.scenarios.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";
import { startPlanReviewServer } from "./serverPlan.ts";

defineDocAnyPathScenarios("pi", async (kind, { docPath, htmlContent }) => {
	if (kind === "plan") return startPlanReviewServer({ plan: "# Plan\n\nSteps", htmlContent, origin: "pi" });
	return startAnnotateServer({ markdown: "# Notes\n", filePath: docPath, htmlContent, mode: "annotate" });
});
