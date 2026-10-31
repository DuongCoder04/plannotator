/**
 * Bun plan and annotate servers: `/api/doc` outside the project (#2291).
 * Scenarios are shared with the Pi mirror
 * (apps/pi-extension/server/doc-any-path.test.ts).
 */
import { defineDocAnyPathScenarios } from "./doc-any-path.scenarios";
import { startPlannotatorServer } from "./index";
import { startAnnotateServer } from "./annotate";
import { allowServedHostname, resetServedHostnamesForTests } from "./request-host-guard";

defineDocAnyPathScenarios(
  "bun",
  async (kind, { docPath, htmlContent }) => {
    if (kind === "plan") return startPlannotatorServer({ plan: "# Plan\n\nSteps", origin: "claude-code", htmlContent });
    return startAnnotateServer({ markdown: "# Notes\n", filePath: docPath, htmlContent, mode: "annotate" });
  },
  {
    allowServedHost: (hostname) => {
      allowServedHostname(hostname);
      return resetServedHostnamesForTests;
    },
  },
);
