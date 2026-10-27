/**
 * Comments on linked documents in sessions whose root has no file of its own
 * (#1545): plan review, and annotate sessions on the last message or a URL.
 * Each linked document is saved under its own path (`/api/draft/document`),
 * listed in an index beside the session draft, and offered back by
 * GET /api/draft as `documents`, so a reload restores every document's
 * comments on its own document.
 *
 * Driven over HTTP against real servers. Shared by the Bun suite
 * (linked-document-drafts.test.ts) and the Pi mirror
 * (apps/pi-extension/server/linked-document-drafts.test.ts), so both runtimes
 * answer the same scenarios. Every test runs under a temp
 * PLANNOTATOR_DATA_DIR, in a temp project folder (the servers serve linked
 * documents from the working directory).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface LinkedDraftServer {
  url: string;
  stop: () => void | Promise<void>;
}

export interface LinkedDraftRuntime {
  startPlan: (options: { plan: string }) => Promise<LinkedDraftServer>;
  startLastMessage: (options: { markdown: string }) => Promise<LinkedDraftServer>;
}

const ENV_KEYS = [
  "PLANNOTATOR_DATA_DIR",
  "PLANNOTATOR_PORT",
  "PLANNOTATOR_REMOTE",
  "PLANNOTATOR_AI",
  "PLANNOTATOR_ANNOTATE_HISTORY",
  "PLANNOTATOR_FEEDBACK_HISTORY",
] as const;

const comment = (id: string) => ({
  id,
  blockId: "",
  startOffset: 0,
  endOffset: 4,
  type: "COMMENT",
  text: id,
  originalText: "Body",
  createdA: 1,
});

const draftBody = (generation: number, ids: string[]) => ({
  annotations: ids.map(comment),
  globalAttachments: [],
  draftGeneration: generation,
  ts: Date.now(),
});

const idsOf = (list: { id: string }[] | undefined) => (list ?? []).map((a) => a.id);

interface LoadedDraft {
  annotations?: { id: string }[];
  documents?: { path: string; annotations: { id: string }[] }[];
  draftGeneration?: number;
}

export function defineLinkedDocumentDraftScenarios(runtime: string, start: LinkedDraftRuntime): void {
  describe(`${runtime} linked documents' drafts in plan review and rootless annotate sessions`, () => {
    const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
    const servers: LinkedDraftServer[] = [];
    let previousCwd = "";
    let root = "";
    let project = "";
    let design = "";
    let notes = "";

    beforeEach(() => {
      for (const key of ENV_KEYS) saved[key] = process.env[key];
      root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-linked-drafts-")));
      process.env.PLANNOTATOR_DATA_DIR = join(root, "data");
      delete process.env.PLANNOTATOR_PORT;
      process.env.PLANNOTATOR_REMOTE = "0";
      process.env.PLANNOTATOR_AI = "disabled";
      process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
      process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
      project = join(root, "project");
      mkdirSync(join(project, "docs"), { recursive: true });
      design = join(project, "docs", "design.md");
      notes = join(project, "docs", "notes.md");
      writeFileSync(design, "# Design\n\nBody of the design.\n");
      writeFileSync(notes, "# Notes\n\nBody of the notes.\n");
      previousCwd = process.cwd();
      process.chdir(project);
    });

    afterEach(async () => {
      for (const server of servers.splice(0)) await server.stop();
      process.chdir(previousCwd);
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key]!;
      }
      rmSync(root, { recursive: true, force: true });
    });

    const planText = () => `# Plan ${Math.random().toString(36).slice(2, 10)}\n\nSee [the design](docs/design.md) and [notes](docs/notes.md).\n`;

    async function openPlan(plan: string): Promise<LinkedDraftServer> {
      const server = await start.startPlan({ plan });
      servers.push(server);
      return server;
    }

    async function close(server: LinkedDraftServer): Promise<void> {
      servers.splice(servers.indexOf(server), 1);
      await server.stop();
    }

    const post = (server: LinkedDraftServer, path: string, body: unknown) =>
      fetch(`${server.url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const saveDocuments = (server: LinkedDraftServer, documents: { path: string; annotations: unknown[] }[]) =>
      post(server, "/api/draft/document", { documents });

    const loadDraft = async (server: LinkedDraftServer): Promise<{ status: number; body: LoadedDraft }> => {
      const res = await fetch(`${server.url}/api/draft`);
      return { status: res.status, body: (await res.json()) as LoadedDraft };
    };

    test("plan review advertises per-document copies", async () => {
      const server = await openPlan(planText());
      expect((await (await fetch(`${server.url}/api/plan`)).json()).documentDrafts).toBe(true);
    });

    test("a reload offers the plan's comments and each linked document's comments on that document", async () => {
      const plan = planText();
      const server = await openPlan(plan);
      expect((await post(server, "/api/draft", draftBody(1, ["on-plan"]))).ok).toBe(true);
      const write = await saveDocuments(server, [{ path: design, annotations: [comment("on-design")] }]);
      expect(write.status).toBe(200);
      expect((await write.json()).written).toBe(1);

      const { status, body } = await loadDraft(server);
      expect(status).toBe(200);
      expect(idsOf(body.annotations)).toEqual(["on-plan"]);
      expect(body.documents?.map((d) => [d.path, idsOf(d.annotations)])).toEqual([[design, ["on-design"]]]);

      // The same plan opened again (a new server: the agent re-ran the hook
      // after a crash) finds them too.
      await close(server);
      const reopened = await openPlan(plan);
      const again = await loadDraft(reopened);
      expect(idsOf(again.body.annotations)).toEqual(["on-plan"]);
      expect(again.body.documents?.map((d) => d.path)).toEqual([design]);
    });

    test("the plan's draft going empty never takes a linked document's comments with it", async () => {
      // The reviewer commented on the plan and on a linked document, then
      // removed the plan's only comment: the client deletes the plan draft.
      const server = await openPlan(planText());
      await post(server, "/api/draft", draftBody(1, ["on-plan"]));
      await saveDocuments(server, [{ path: design, annotations: [comment("on-design")] }]);
      expect((await fetch(`${server.url}/api/draft?generation=2`, { method: "DELETE" })).ok).toBe(true);

      const { status, body } = await loadDraft(server);
      expect(status).toBe(200);
      expect(body.annotations).toEqual([]);
      expect(body.documents?.map((d) => [d.path, idsOf(d.annotations)])).toEqual([[design, ["on-design"]]]);
      // The client resumes above the plan draft's tombstone.
      expect(body.draftGeneration).toBe(2);
    });

    test("a single-document plan's draft is served exactly as before", async () => {
      const server = await openPlan(planText());
      const stored = draftBody(3, ["only-plan"]);
      await post(server, "/api/draft", stored);
      const { status, body } = await loadDraft(server);
      expect(status).toBe(200);
      expect(body).toEqual(JSON.parse(JSON.stringify(stored)));

      const empty = await openPlan(planText());
      expect((await loadDraft(empty)).status).toBe(404);
    });

    test("a document read back is offered on the next reload", async () => {
      // A copy saved by an earlier session that this session read when the
      // reviewer opened the document is part of this session's draft now.
      const first = await openPlan(planText());
      await saveDocuments(first, [{ path: notes, annotations: [comment("earlier")] }]);
      await close(first);

      const second = await openPlan(planText());
      const read = await fetch(`${second.url}/api/draft/document?path=${encodeURIComponent(notes)}`);
      expect(read.status).toBe(200);
      expect(idsOf((await read.json()).annotations)).toEqual(["earlier"]);
      expect((await loadDraft(second)).body.documents?.map((d) => d.path)).toEqual([notes]);
    });

    test("an emptied document is no longer offered", async () => {
      const server = await openPlan(planText());
      await post(server, "/api/draft", draftBody(1, ["on-plan"]));
      await saveDocuments(server, [{ path: design, annotations: [comment("on-design")] }]);
      await saveDocuments(server, [{ path: design, annotations: [] }]);
      const { body } = await loadDraft(server);
      expect(idsOf(body.annotations)).toEqual(["on-plan"]);
      expect(body.documents).toBeUndefined();
      expect((await fetch(`${server.url}/api/draft/document?path=${encodeURIComponent(design)}`)).status).toBe(404);
    });

    test("a decision clears every linked document's copy and refuses later writes", async () => {
      const plan = planText();
      const server = await openPlan(plan);
      await post(server, "/api/draft", draftBody(1, ["on-plan"]));
      await saveDocuments(server, [
        { path: design, annotations: [comment("on-design")] },
        { path: notes, annotations: [comment("on-notes")] },
      ]);
      const deny = await post(server, "/api/deny", { feedback: "Changes", planSave: { enabled: false }, draftGeneration: 2 });
      expect(deny.status).toBe(200);
      expect((await saveDocuments(server, [{ path: design, annotations: [comment("late")] }])).status).toBe(409);
      await close(server);

      const reopened = await openPlan(plan);
      expect((await loadDraft(reopened)).status).toBe(404);
      for (const path of [design, notes]) {
        expect((await fetch(`${reopened.url}/api/draft/document?path=${encodeURIComponent(path)}`)).status).toBe(404);
      }
    });

    test("a document outside the project is refused and never offered", async () => {
      const outside = join(root, "outside.md");
      writeFileSync(outside, "# Outside\n");
      const server = await openPlan(planText());
      const res = await saveDocuments(server, [
        { path: outside, annotations: [comment("outside")] },
        { path: design, annotations: [comment("inside")] },
      ]);
      expect(res.status).toBe(200);
      expect((await res.json()).rejected).toEqual([outside]);
      expect((await fetch(`${server.url}/api/draft/document?path=${encodeURIComponent(outside)}`)).status).toBe(403);
      expect((await loadDraft(server)).body.documents?.map((d) => d.path)).toEqual([design]);
    });

    test("an annotate session on the last message offers its linked documents the same way", async () => {
      const server = await start.startLastMessage({ markdown: "# Agent message\n\nSee docs/design.md.\n" });
      servers.push(server);
      expect((await (await fetch(`${server.url}/api/plan`)).json()).documentDrafts).toBe(true);
      await post(server, "/api/draft", draftBody(1, ["on-message"]));
      await saveDocuments(server, [{ path: design, annotations: [comment("on-design")] }]);
      const { body } = await loadDraft(server);
      expect(idsOf(body.annotations)).toEqual(["on-message"]);
      expect(body.documents?.map((d) => [d.path, idsOf(d.annotations)])).toEqual([[design, ["on-design"]]]);

      const sent = await post(server, "/api/feedback", { feedback: "Thanks", annotations: [], draftGeneration: 2 });
      expect(sent.status).toBe(200);
      expect((await fetch(`${server.url}/api/draft/document?path=${encodeURIComponent(design)}`)).status).toBe(404);
    });
  });
}
