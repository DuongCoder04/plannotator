/**
 * Readable +/- counts for the sidebar's "All changes" row.
 *
 * The row drew `--success` / `--destructive` at 60% opacity, which read under
 * 2:1 in several palettes (approved design record "review-sidebar-header"
 * asked for 4.5:1). The palettes' own tokens cannot promise it either: in many
 * of them `--success` or `--destructive` sits too close to the sidebar's
 * ground, and in a few even `--foreground` is under 4.5:1 on the selected
 * row. So the colours are derived from the live tokens: each count keeps its
 * hue and moves toward the foreground (then black or white) just far enough to
 * reach 4.5:1 on every surface the row is drawn on.
 */
import {
  compositeOver,
  contrastRatio,
  mixOklab,
  parseCssColor,
  quantize,
  toHex,
  type RgbColor,
} from '@plannotator/ui/utils/cssColor';

export const DIFF_COUNT_CONTRAST_MIN = 4.5;
/** Kept above the minimum: the browser composites the translucent grounds in
 *  its own space, a hair off what is measured here. */
const HEADROOM = 0.1;

export interface DiffCountTokens {
  background?: string;
  foreground?: string;
  card?: string;
  muted?: string;
  primary?: string;
  success?: string;
  destructive?: string;
}

const BLACK: RgbColor = { r: 0, g: 0, b: 0, a: 1 };
const WHITE: RgbColor = { r: 1, g: 1, b: 1, a: 1 };

/**
 * The grounds the row is drawn on, opaque: the sidebar (`bg-card/30` over the
 * page), the selected row (`bg-primary/15` over that) and the hovered row
 * (`bg-muted`).
 */
export function diffCountSurfaces(tokens: DiffCountTokens): RgbColor[] | undefined {
  const background = parseCssColor(tokens.background);
  if (!background) return undefined;
  const page = compositeOver(background, WHITE);
  const card = parseCssColor(tokens.card);
  const aside = card ? compositeOver({ ...card, a: card.a * 0.3 }, page) : page;
  const surfaces = [aside];
  const primary = parseCssColor(tokens.primary);
  if (primary) surfaces.push(compositeOver({ ...primary, a: primary.a * 0.15 }, aside));
  const muted = parseCssColor(tokens.muted);
  if (muted) surfaces.push(compositeOver(muted, aside));
  return surfaces.map(quantize);
}

const worstContrast = (color: RgbColor, surfaces: readonly RgbColor[]) =>
  Math.min(...surfaces.map((surface) => contrastRatio(color, surface)));

/**
 * `color` itself when it already reads at `min` on every surface; otherwise
 * the smallest move toward the first ink that gets there (the foreground,
 * then black, then white), or the best of them when none does.
 */
export function readableOnAll(color: RgbColor, surfaces: readonly RgbColor[], min: number, inks: readonly RgbColor[]): RgbColor {
  const start = quantize(color);
  if (worstContrast(start, surfaces) >= min) return start;
  let best = start;
  let bestRatio = worstContrast(start, surfaces);
  for (const ink of [...inks, BLACK, WHITE]) {
    const inkRatio = worstContrast(ink, surfaces);
    if (inkRatio < min) {
      if (inkRatio > bestRatio) {
        best = quantize(ink);
        bestRatio = inkRatio;
      }
      continue;
    }
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (worstContrast(quantize(mixOklab(start, ink, mid)), surfaces) >= min) hi = mid;
      else lo = mid;
    }
    return quantize(mixOklab(start, ink, hi));
  }
  return best;
}

/** `#rrggbb` for the + and - counts, or undefined when the tokens cannot be read. */
export function diffCountColors(tokens: DiffCountTokens | undefined): { additions: string; deletions: string } | undefined {
  if (!tokens) return undefined;
  const surfaces = diffCountSurfaces(tokens);
  const foreground = parseCssColor(tokens.foreground);
  const success = parseCssColor(tokens.success);
  const destructive = parseCssColor(tokens.destructive);
  if (!surfaces || !foreground || !success || !destructive) return undefined;
  const ink = quantize(compositeOver(foreground, surfaces[0]));
  const min = DIFF_COUNT_CONTRAST_MIN + HEADROOM;
  return {
    additions: toHex(readableOnAll(compositeOver(success, surfaces[0]), surfaces, min, [ink])),
    deletions: toHex(readableOnAll(compositeOver(destructive, surfaces[0]), surfaces, min, [ink])),
  };
}
