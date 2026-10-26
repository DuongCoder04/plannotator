/**
 * Pi annotate server: the file browser over its file cap. Same scenarios as
 * the Bun server (packages/server/file-browser-cap.scenarios.ts), so the
 * mirror cannot drift.
 */
import { defineFileBrowserCapScenarios } from "../../../packages/server/file-browser-cap.scenarios.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";

defineFileBrowserCapScenarios("pi", async (options) => {
	const server = await startAnnotateServer({
		...options,
		htmlContent: "<html><body>Plannotator</body></html>",
	});
	return { url: server.url, stop: server.stop };
});
