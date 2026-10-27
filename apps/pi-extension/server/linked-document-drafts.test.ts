/**
 * Pi servers: linked documents' drafts in plan review and in annotate
 * sessions without a file (#1545). Same scenarios as the Bun servers
 * (packages/server/linked-document-drafts.scenarios.ts), so the mirror cannot
 * drift.
 */
import { defineLinkedDocumentDraftScenarios } from "../../../packages/server/linked-document-drafts.scenarios.ts";
import { startPlanReviewServer } from "./serverPlan.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";

defineLinkedDocumentDraftScenarios("pi", {
	startPlan: async ({ plan }) => {
		const server = await startPlanReviewServer({ plan, htmlContent: MINIMAL_HTML, origin: "pi" });
		return { url: server.url, stop: server.stop };
	},
	startLastMessage: async ({ markdown }) => {
		const server = await startAnnotateServer({
			markdown,
			filePath: "last-message",
			mode: "annotate-last",
			htmlContent: MINIMAL_HTML,
		});
		return { url: server.url, stop: server.stop };
	},
});
