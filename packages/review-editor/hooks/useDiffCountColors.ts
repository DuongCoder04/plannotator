import { useLayoutEffect, useState } from 'react';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { parseCssColor } from '@plannotator/ui/utils/cssColor';
import { diffCountColors, type DiffCountTokens } from '../utils/diffCountColors';

const TOKEN_NAMES = ['background', 'foreground', 'card', 'muted', 'primary', 'success', 'destructive'] as const;

/**
 * The palette's tokens off the document element. A value the parser cannot
 * read as written (a `color-mix()`, a `var()` chain) is resolved by the
 * engine through a hidden probe.
 */
function readDiffCountTokens(): DiffCountTokens | undefined {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return undefined;
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const tokens: DiffCountTokens = {};
  let probe: HTMLSpanElement | null = null;
  try {
    for (const name of TOKEN_NAMES) {
      const raw = computed.getPropertyValue(`--${name}`).trim();
      if (!raw) continue;
      if (parseCssColor(raw)) {
        tokens[name] = raw;
        continue;
      }
      if (!probe) {
        probe = document.createElement('span');
        probe.setAttribute('aria-hidden', 'true');
        probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
        root.appendChild(probe);
      }
      probe.style.color = `var(--${name})`;
      const resolved = getComputedStyle(probe).color.trim();
      if (parseCssColor(resolved)) tokens[name] = resolved;
    }
  } finally {
    probe?.remove();
  }
  return tokens;
}

/**
 * The "All changes" row's +/- colours for the palette on screen, read from
 * the live tokens again whenever the palette or mode changes. Undefined until
 * they can be read: the row then falls back to the plain `--success` /
 * `--destructive` tokens.
 */
export function useDiffCountColors(): { additions: string; deletions: string } | undefined {
  const { colorTheme, resolvedMode } = useTheme();
  const [colors, setColors] = useState<{ additions: string; deletions: string } | undefined>(undefined);
  useLayoutEffect(() => {
    const next = diffCountColors(readDiffCountTokens());
    setColors((prev) => (prev?.additions === next?.additions && prev?.deletions === next?.deletions ? prev : next));
  }, [colorTheme, resolvedMode]);
  return colors;
}
