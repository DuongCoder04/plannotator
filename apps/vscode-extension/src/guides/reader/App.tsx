import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiffTokenEventBaseProps, SelectedLineRange } from "@pierre/diffs";
import type { CodeGuideData } from "@plannotator/core/guide";
import { GuideHostProvider, type GuideHostValue } from "@plannotator/guide-viewer/host";
import { GuideView } from "@plannotator/guide-viewer/GuideView";
import { engineLabel } from "@plannotator/guide-viewer/GuideViewer";
import { parseDiffToFiles } from "@plannotator/guide-viewer/diffParser";
import type { DiffFile } from "@plannotator/guide-viewer/types";
import { TokenHoverCard } from "@plannotator/review-editor/components/TokenHoverCard";
import { useTokenHover, type TokenHoverResolver } from "@plannotator/review-editor/hooks/useTokenHover";
import { buildCodeNavRequest, buildTokenHoverRequest } from "@plannotator/review-editor/utils/buildCodeNavRequest";
import type { CodeNavHoverResponse, CodeNavRequest } from "@plannotator/shared/code-nav";
import type { AIChatEntry } from "@plannotator/ui/hooks/useAIChat";
import type { AnswerMarker, ChapterAnswers, DiffPosition, HoverAnswer, NavigateAction, ReaderInit } from "../reader-protocol";
import { onMessage, post, requestHover, viewState } from "./bridge";
import { ReaderDiffRenderer, type ReaderDiffProps } from "./DiffRenderer";
import { HoverCardContent } from "./HoverCard";
import { ChapterStrip } from "./ChapterStrip";
import { ChapterAsk } from "./ChapterAsk";
import { answerChatEntries } from "./ask-markers";

const OverviewDiagram = lazy(() => import("./OverviewDiagram"));

/** The hover card's data: the search card's shape (what `useTokenHover` keys and gates on), carrying the language server's answer. */
type ReaderHoverData = CodeNavHoverResponse & { reader: { answer: HoverAnswer; at: DiffPosition } };

/** Each hover is keyed by its position, not only its name: the language server answers per position. */
const POSITION_MARK = "\u0001";

function positionOf(request: CodeNavRequest): DiffPosition {
  const [token] = request.symbol.split(POSITION_MARK);
  return { path: request.filePath, side: request.side, line: request.line, character: request.charStart, token };
}

const resolveHover: TokenHoverResolver = async (request, signal) => {
  const at = positionOf(request);
  const answer = await requestHover(at, signal);
  if (!answer || (!answer.blocks.length && !answer.definition)) return null;
  const def = answer.definition;
  const data: ReaderHoverData = {
    backend: "search",
    source: "search",
    symbol: answer.symbol,
    // The search card shows a card only with a definition; the language server's hover is enough here.
    definition: {
      filePath: def?.path ?? at.path,
      line: def?.line ?? at.line,
      column: def?.character ?? at.character,
      confidence: "likely",
      symbolKind: null,
      signature: null,
      signatureApproximate: false,
      doc: null,
      preview: null,
      otherCandidateCount: 0,
    },
    alternateDefinition: null,
    references: [],
    referenceCount: 0,
    capped: false,
    stats: { elapsedMs: answer.elapsedMs },
    reader: { answer, at },
  };
  return data;
};

export function ReaderApp({ init }: { init: ReaderInit }) {
  const { snapshot } = init;
  const files = useMemo<DiffFile[]>(() => parseDiffToFiles(snapshot.review.rawPatch), [snapshot.review.rawPatch]);
  const [reviewed, setReviewed] = useState<boolean[]>(init.reviewed);
  const [focusedFile, setFocusedFile] = useState<string | null>(null);
  const [revealFile, setRevealFile] = useState<{ path: string; token: number } | null>(null);
  const revealToken = useRef(0);
  const [asks, setAsks] = useState<{ busy: boolean; markers: AnswerMarker[]; chapters: ChapterAnswers[]; agent: string | null }>({
    busy: false,
    markers: [],
    chapters: [],
    agent: init.askAgent,
  });
  const [back, setBack] = useState<{ label: string; scrollY: number } | null>(null);
  const mod = init.platform === "mac" ? "⌘" : "Ctrl";

  const guide = useMemo<CodeGuideData>(
    () => ({
      title: snapshot.guide.title,
      intent: snapshot.guide.intent,
      ...(snapshot.guide.overview && { overview: snapshot.guide.overview }),
      sections: snapshot.guide.sections,
      unplacedFiles: snapshot.guide.unplacedFiles,
      reviewed: [...reviewed],
      ...(init.moved && { moved: true }),
    }),
    [snapshot.guide, reviewed, init.moved],
  );

  const reveal = useCallback((path: string) => {
    revealToken.current += 1;
    setRevealFile({ path, token: revealToken.current });
  }, []);

  const scrollToChapter = useCallback((index: number) => {
    const el = document.querySelector(`[data-guide-section="${index}"]`);
    if (el) {
      const top = el.getBoundingClientRect().top + window.scrollY - stripHeight();
      window.scrollTo({ top, behavior: "smooth" });
    }
  }, []);

  useEffect(
    () =>
      onMessage((msg) => {
        if (msg.type === "reviewed") setReviewed(msg.reviewed);
        else if (msg.type === "checkMermaid") {
          void import("./OverviewDiagram")
            .then((m) => m.checkMermaidHere(msg.source))
            .then((r) => post({ type: "mermaidResult", reqId: msg.reqId, ok: r.ok, ...(r.message && { message: r.message }), ...(r.line && { line: r.line }) }));
        } else if (msg.type === "asks") setAsks({ busy: msg.busy, markers: msg.markers, chapters: msg.chapters, agent: msg.agent });
        else if (msg.type === "reveal") {
          if (msg.path) {
            setBack({ label: "Back", scrollY: window.scrollY });
            reveal(msg.path);
          } else if (typeof msg.chapter === "number") scrollToChapter(msg.chapter);
        }
      }),
    [reveal, scrollToChapter],
  );

  // Hover: the extension asks the language server on the real file.
  const hover = useTokenHover(init.guideId, { resolve: resolveHover });
  const onTokenHoverEnter = useCallback(
    (props: DiffTokenEventBaseProps, filePath: string) => {
      const request = buildTokenHoverRequest(props, filePath);
      if (!request) return;
      hover.onTokenHoverEnter({ ...request, symbol: `${request.symbol}${POSITION_MARK}${request.line}:${request.charStart}` }, props.tokenElement);
    },
    [hover.onTokenHoverEnter],
  );
  const onCodeNavRequest = useCallback(
    (request: CodeNavRequest) => {
      hover.close();
      setBack({ label: "Back", scrollY: window.scrollY });
      post({ type: "navigate", at: positionOf(request), action: "definition" });
    },
    [hover.close],
  );

  // The selected lines, per file: the selection toolbar's Ask asks about them.
  const [selection, setSelection] = useState<{ path: string; range: SelectedLineRange } | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const onAskAIForFile = useCallback((filePath: string, question: string) => {
    const sel = selectionRef.current;
    if (!sel || sel.path !== filePath || !question.trim()) return;
    const start = Math.min(sel.range.start, sel.range.end);
    const end = Math.max(sel.range.start, sel.range.end);
    post({ type: "ask", question: question.trim(), path: filePath, start, end });
    setSelection(null);
  }, []);
  const aiMessages = useMemo(() => answerChatEntries(asks.markers), [asks.markers]);
  const onClickAIMarker = useCallback((id: string) => post({ type: "openAnswer", id }), []);

  const fontVars = useMemo(() => {
    const style = getComputedStyle(document.documentElement);
    const family = style.getPropertyValue("--vscode-editor-font-family").trim();
    const size = style.getPropertyValue("--vscode-editor-font-size").trim();
    return { family: family || undefined, size: size || undefined };
  }, []);

  const diffProps = useMemo<ReaderDiffProps>(
    () => ({
      fontFamily: fontVars.family,
      fontSize: fontVars.size,
      onTokenHoverEnter,
      onTokenHoverLeave: hover.onTokenHoverLeave,
      onCodeNavRequest,
      ...(init.askAgent && { onAskAIForFile }),
      aiMessages: [] as AIChatEntry[],
      onClickAIMarker,
      isAILoading: asks.busy,
      pendingSelection: null,
      onLineSelection: () => {},
    }),
    [fontVars, onTokenHoverEnter, hover.onTokenHoverLeave, onCodeNavRequest, onAskAIForFile, onClickAIMarker, asks.busy, init.askAgent],
  );
  const getDiffRendererProps = useCallback(
    ({ file }: { file: DiffFile }) => ({
      ...diffProps,
      aiMessages: aiMessages.filter((m) => m.question.filePath === file.path),
      pendingSelection: selection?.path === file.path ? selection.range : null,
      onLineSelection: (range: SelectedLineRange | null) => setSelection(range ? { path: file.path, range } : (prev) => (prev?.path === file.path ? null : prev)),
    }),
    [diffProps, aiMessages, selection],
  );

  const host = useMemo<GuideHostValue<ReaderDiffProps>>(
    () => ({
      files,
      DiffRenderer: ReaderDiffRenderer,
      getDiffRendererProps,
      revealFile,
      onRevealFile: reveal,
      renderFileActions: (file) => <FileActions file={file} />,
      renderOverviewDiagram: (diagram) =>
        diagram.kind === "mermaid" ? (
          <Suspense fallback={<pre className="overflow-x-auto whitespace-pre rounded-md bg-muted/50 p-3 font-mono text-[11px] text-muted-foreground">{diagram.source}</pre>}>
            <OverviewDiagram source={diagram.source} onChapter={scrollToChapter} />
          </Suspense>
        ) : null,
      renderLink: (href, label, key) => {
        const symbol = href.startsWith("symbol:");
        if (!symbol && !href.startsWith("code:")) return null;
        return (
          <button
            key={key}
            type="button"
            className="text-primary underline-offset-2 hover:underline"
            title={symbol ? `Go to ${href.slice(7)}` : `Open ${href.slice(5)}`}
            onClick={() => post({ type: "link", href, action: symbol ? "definition" : "open" })}
          >
            {label}
          </button>
        );
      },
      renderSectionFooter: (index) =>
        index < snapshot.guide.sections.length ? (
          <ChapterAsk chapter={index} agent={asks.agent} busy={asks.busy} answers={asks.chapters.find((c) => c.chapter === index)?.items ?? []} />
        ) : null,
    }),
    [files, getDiffRendererProps, revealFile, reveal, snapshot.guide.sections.length, asks, scrollToChapter],
  );

  const onToggleReviewed = useCallback((index: number) => {
    setReviewed((prev) => prev.map((v, i) => (i === index ? !v : v)));
    post({ type: "toggleReviewed", chapter: index });
  }, []);

  const hoverData = hover.hover?.data as ReaderHoverData | undefined;

  return (
    <GuideHostProvider value={host}>
      <ChapterStrip
        title={init.title}
        label={init.label}
        chapters={snapshot.guide.sections.map((s, i) => ({ title: s.title, color: init.chapterColors[i] ?? "var(--primary)", reviewed: !!reviewed[i] }))}
        onChapter={(i) => {
          scrollToChapter(i);
          post({ type: "chapter", chapter: i });
        }}
        onOverview={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        back={back}
        onBack={() => {
          if (back) window.scrollTo({ top: back.scrollY, behavior: "smooth" });
          setBack(null);
        }}
      />
      <div className="pn-reader-body min-h-screen bg-background text-foreground">
        <GuideView
          guide={guide}
          reviewed={reviewed}
          onToggleReviewed={onToggleReviewed}
          engineLabel={engineLabel(snapshot.generator?.engine, snapshot.generator?.model)}
          focusedFile={focusedFile}
          onFocusFile={setFocusedFile}
          sourceLine={init.changedSince.length ? <span>Changed on disk since the guide: {init.changedSince.join(", ")}</span> : undefined}
        />
      </div>
      {hover.hover && hoverData?.reader && (
        <TokenHoverCard
          hover={hover.hover}
          onPointerEnter={hover.onCardEnter}
          onPointerLeave={hover.onCardLeave}
          onSelectLocation={() => {}}
          content={
            <HoverCardContent
              answer={hoverData.reader.answer}
              at={hoverData.reader.at}
              mod={mod}
              onNavigate={(action: NavigateAction) => {
                hover.close();
                if (action === "definition") setBack({ label: "Back", scrollY: window.scrollY });
                post({ type: "navigate", at: hoverData.reader.at, action });
              }}
              onOpenDefinition={() => {
                const def = hoverData.reader.answer.definition;
                hover.close();
                if (def) post({ type: "openLocation", path: def.path, line: def.line, character: def.character });
              }}
            />
          }
        />
      )}
    </GuideHostProvider>
  );
}

function stripHeight(): number {
  return (document.querySelector("[data-reader-strip]") as HTMLElement | null)?.offsetHeight ?? 0;
}

function FileActions({ file }: { file: DiffFile }) {
  const deleted = file.status === "deleted";
  return (
    <>
      {!deleted && (
        <button type="button" className="pn-file-action" title={`Open ${file.path} in an editor beside the guide`} onClick={() => post({ type: "openFile", path: file.path })}>
          <span className="codicon codicon-go-to-file" aria-hidden="true" />
          Open in editor
        </button>
      )}
      <button type="button" className="pn-file-action" title="Open this file's diff in VS Code's diff editor beside the guide" onClick={() => post({ type: "openDiff", path: file.path })}>
        <span className="codicon codicon-diff" aria-hidden="true" />
        Diff
      </button>
    </>
  );
}

export { viewState };
