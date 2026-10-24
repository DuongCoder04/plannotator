import React, { useEffect, useState } from "react";
import { post } from "./bridge";

interface StripChapter {
  title: string;
  color: string;
  reviewed: boolean;
}

/**
 * The Guide tab's top strip: the guide's title, how many chapters are
 * reviewed, Overview and one pill per chapter (its color, its number, a
 * check when reviewed; the one in view is marked), then Export and the
 * outline. It stays at the top while the guide scrolls, so the side bar is
 * not needed to find a chapter.
 */
export function ChapterStrip({
  title,
  label,
  chapters,
  onChapter,
  onOverview,
  back,
  onBack,
}: {
  title: string;
  label: string;
  chapters: StripChapter[];
  onChapter: (index: number) => void;
  onOverview: () => void;
  back: { label: string } | null;
  onBack: () => void;
}) {
  const current = useChapterInView(chapters.length);
  const reviewed = chapters.filter((c) => c.reviewed).length;
  return (
    <header data-reader-strip className="pn-strip sticky top-0 z-40 flex items-center gap-2 border-b border-border bg-background/95 px-3 py-1.5 backdrop-blur">
      <span className="codicon codicon-book flex-shrink-0 text-muted-foreground" aria-hidden="true" />
      <h1 className="min-w-0 flex-shrink truncate text-[13px] font-semibold text-foreground" title={title}>
        {label ? `${label} · ` : ""}
        {title}
      </h1>
      <span className="flex-shrink-0 whitespace-nowrap text-[12px] text-muted-foreground">
        {reviewed} of {chapters.length} reviewed
      </span>
      {back && (
        <button type="button" className="pn-pill flex-shrink-0" onClick={onBack} title="Back to where you were reading">
          <span className="codicon codicon-arrow-left" aria-hidden="true" /> {back.label}
        </button>
      )}
      <span className="flex-1" />
      <nav className="flex min-w-0 items-center gap-1 overflow-x-auto" aria-label="Chapters">
        <button type="button" className="pn-pill flex-shrink-0" onClick={onOverview}>
          Overview
        </button>
        {chapters.map((c, i) => (
          <button
            key={i}
            type="button"
            className="pn-pill flex-shrink-0"
            data-current={current === i || undefined}
            aria-current={current === i ? "true" : undefined}
            title={`Chapter ${i + 1} · ${c.title}${c.reviewed ? " · reviewed" : ""}`}
            onClick={() => onChapter(i)}
          >
            <span className="pn-dot" style={{ background: c.color }} aria-hidden="true" />
            {c.reviewed ? <span className="codicon codicon-check text-success" aria-label="reviewed" /> : <span>{i + 1}</span>}
          </button>
        ))}
      </nav>
      <button type="button" className="pn-pill flex-shrink-0" onClick={() => post({ type: "command", command: "export" })} title="Download the guide as one HTML file that opens in any browser">
        <span className="codicon codicon-link-external" aria-hidden="true" /> Export
      </button>
      <button type="button" className="pn-pill flex-shrink-0" onClick={() => post({ type: "command", command: "outline" })} title="Show the guide's outline in the side bar" aria-label="Show the outline">
        <span className="codicon codicon-list-tree" aria-hidden="true" />
      </button>
    </header>
  );
}

/** The chapter whose card holds the line just under the strip. */
function useChapterInView(count: number): number {
  const [current, setCurrent] = useState(0);
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      raf = 0;
      const strip = (document.querySelector("[data-reader-strip]") as HTMLElement | null)?.offsetHeight ?? 0;
      const y = strip + 8;
      let found = 0;
      for (let i = 0; i < count; i++) {
        const el = document.querySelector(`[data-guide-section="${i}"]`);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= y) found = i;
      }
      setCurrent((prev) => (prev === found ? prev : found));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [count]);
  useEffect(() => {
    post({ type: "chapter", chapter: current });
  }, [current]);
  return current;
}
