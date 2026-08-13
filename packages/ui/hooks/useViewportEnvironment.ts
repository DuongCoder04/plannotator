import { useEffect } from 'react';

export interface VisualViewportSnapshot {
  width: number;
  height: number;
  offsetTop: number;
  offsetLeft: number;
  scale: number;
}

export interface ViewportEnvironmentInput {
  layoutWidth: number;
  layoutHeight: number;
  visualViewport?: VisualViewportSnapshot | null;
}

export interface ViewportEnvironment {
  width: number;
  height: number;
  offsetTop: number;
  offsetLeft: number;
  keyboardInset: number;
}

const VIEWPORT_PROPERTIES = [
  '--pn-viewport-width',
  '--pn-viewport-height',
  '--pn-viewport-offset-top',
  '--pn-viewport-offset-left',
  '--pn-keyboard-inset',
] as const;

type ViewportProperty = (typeof VIEWPORT_PROPERTIES)[number];

let subscriberCount = 0;
let stopObserving: (() => void) | null = null;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function positiveOr(value: number, fallback: number): number {
  const finite = finiteOr(value, fallback);
  return finite > 0 ? finite : fallback;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Converts the visual viewport into application-stage geometry. Pinch zoom is
 * intentionally represented by offsets only: reshaping the app while a user
 * zooms and pans would fight accessibility zoom. At the normal scale, browser
 * chrome and the software keyboard are allowed to reduce the usable stage.
 */
export function calculateViewportEnvironment({
  layoutWidth,
  layoutHeight,
  visualViewport,
}: ViewportEnvironmentInput): ViewportEnvironment {
  const safeLayoutWidth = Math.max(0, finiteOr(layoutWidth, 0));
  const safeLayoutHeight = Math.max(0, finiteOr(layoutHeight, 0));

  if (!visualViewport) {
    return {
      width: rounded(safeLayoutWidth),
      height: rounded(safeLayoutHeight),
      offsetTop: 0,
      offsetLeft: 0,
      keyboardInset: 0,
    };
  }

  const scale = positiveOr(visualViewport.scale, 1);
  const offsetTop = Math.max(0, finiteOr(visualViewport.offsetTop, 0));
  const offsetLeft = Math.max(0, finiteOr(visualViewport.offsetLeft, 0));
  const isPinchZoomed = Math.abs(scale - 1) > 0.01;
  if (isPinchZoomed) {
    return {
      width: rounded(safeLayoutWidth),
      height: rounded(safeLayoutHeight),
      offsetTop: rounded(offsetTop),
      offsetLeft: rounded(offsetLeft),
      keyboardInset: 0,
    };
  }

  const scaledWidth = positiveOr(visualViewport.width, safeLayoutWidth);
  const scaledHeight = positiveOr(visualViewport.height, safeLayoutHeight);
  const availableWidth = Math.max(0, safeLayoutWidth - offsetLeft);
  const availableHeight = Math.max(0, safeLayoutHeight - offsetTop);
  const width = safeLayoutWidth > 0 ? Math.min(scaledWidth, availableWidth) : scaledWidth;
  const height = safeLayoutHeight > 0 ? Math.min(scaledHeight, availableHeight) : scaledHeight;

  return {
    width: rounded(Math.max(0, width)),
    height: rounded(Math.max(0, height)),
    offsetTop: rounded(offsetTop),
    offsetLeft: rounded(offsetLeft),
    keyboardInset: rounded(Math.max(0, safeLayoutHeight - offsetTop - height)),
  };
}

function readViewportEnvironment(targetWindow: Window): ViewportEnvironment {
  const visualViewport = targetWindow.visualViewport;
  return calculateViewportEnvironment({
    layoutWidth: targetWindow.innerWidth,
    layoutHeight: targetWindow.innerHeight,
    visualViewport: visualViewport
      ? {
          width: visualViewport.width,
          height: visualViewport.height,
          offsetTop: visualViewport.offsetTop,
          offsetLeft: visualViewport.offsetLeft,
          scale: visualViewport.scale,
        }
      : null,
  });
}

function cssValues(environment: ViewportEnvironment): Record<ViewportProperty, string> {
  return {
    '--pn-viewport-width': `${environment.width}px`,
    '--pn-viewport-height': `${environment.height}px`,
    '--pn-viewport-offset-top': `${environment.offsetTop}px`,
    '--pn-viewport-offset-left': `${environment.offsetLeft}px`,
    '--pn-keyboard-inset': `${environment.keyboardInset}px`,
  };
}

function startViewportEnvironmentObserver(
  targetWindow: Window,
  targetDocument: Document,
): () => void {
  const rootStyle = targetDocument.documentElement.style;
  const previousValues = new Map<ViewportProperty, string>();
  const writtenValues = new Map<ViewportProperty, string>();
  for (const property of VIEWPORT_PROPERTIES) {
    previousValues.set(property, rootStyle.getPropertyValue(property));
  }

  let animationFrame: number | null = null;

  const write = () => {
    animationFrame = null;
    const nextValues = cssValues(readViewportEnvironment(targetWindow));
    for (const property of VIEWPORT_PROPERTIES) {
      const nextValue = nextValues[property];
      if (writtenValues.get(property) === nextValue) continue;
      rootStyle.setProperty(property, nextValue);
      writtenValues.set(property, nextValue);
    }
  };

  const scheduleWrite = () => {
    if (animationFrame !== null) return;
    animationFrame = targetWindow.requestAnimationFrame(write);
  };

  const visualViewport = targetWindow.visualViewport;
  targetWindow.addEventListener('resize', scheduleWrite);
  targetWindow.addEventListener('orientationchange', scheduleWrite);
  targetWindow.addEventListener('pageshow', scheduleWrite);
  targetDocument.addEventListener('visibilitychange', scheduleWrite);
  visualViewport?.addEventListener('resize', scheduleWrite);
  visualViewport?.addEventListener('scroll', scheduleWrite);
  write();

  return () => {
    targetWindow.removeEventListener('resize', scheduleWrite);
    targetWindow.removeEventListener('orientationchange', scheduleWrite);
    targetWindow.removeEventListener('pageshow', scheduleWrite);
    targetDocument.removeEventListener('visibilitychange', scheduleWrite);
    visualViewport?.removeEventListener('resize', scheduleWrite);
    visualViewport?.removeEventListener('scroll', scheduleWrite);
    if (animationFrame !== null) targetWindow.cancelAnimationFrame(animationFrame);

    for (const property of VIEWPORT_PROPERTIES) {
      const previousValue = previousValues.get(property) ?? '';
      if (previousValue) rootStyle.setProperty(property, previousValue);
      else rootStyle.removeProperty(property);
    }
  };
}

function acquireViewportEnvironment(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};

  subscriberCount += 1;
  if (subscriberCount === 1) {
    stopObserving = startViewportEnvironmentObserver(window, document);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    subscriberCount = Math.max(0, subscriberCount - 1);
    if (subscriberCount !== 0) return;
    stopObserving?.();
    stopObserving = null;
  };
}

/**
 * Keeps Plannotator's shared viewport CSS properties synchronized without
 * putting high-frequency browser geometry into React state.
 */
export function useViewportEnvironment(): void {
  useEffect(() => acquireViewportEnvironment(), []);
}
