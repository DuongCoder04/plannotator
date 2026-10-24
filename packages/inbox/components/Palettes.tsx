/**
 * Settings → General → Appearance → Colors: the palette for the light half
 * and the dark half, the same choices plan review's Theme tab offers
 * (ThemeTab's useThemePaletteHalves, over the palette registry, so a palette
 * added there shows here by itself). A pick applies at once, is kept in the
 * `plannotator-theme` cookie, and only that half goes to config.json `theme`
 * (useInboxPalettes in theme.ts), so plan review opens on it too.
 *
 * Two radio groups: which half (Light / Dark, starting on the one on screen),
 * then that half's palettes as tiles. Native radios, so arrows move the pick
 * and Tab leaves the group; no new shortcut.
 */

import { useLayoutEffect, useRef } from 'react';
import { paletteSwatchColors } from '@plannotator/ui/components/ThemeTab';
import type { ThemeHalf } from '@plannotator/ui/utils/themeRegistry';
import { Icon } from '../icons';
import { useInboxPalettes } from '../theme';

const HALVES: { id: ThemeHalf; label: string; icon: 'sun' | 'moon' }[] = [
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
];

export function PaletteRow() {
  const { half, setHalf, pair, themes, nameOf, choose, shown } = useInboxPalettes();
  const halfLabel = half === 'light' ? 'Light' : 'Dark';
  const box = useRef<HTMLDivElement>(null);
  // The chosen palette in view inside the tiles' own box (on a desktop it scrolls), never scrolling the page.
  useLayoutEffect(() => {
    const el = box.current;
    const on = el?.querySelector<HTMLElement>('.ib-pal[data-on]');
    if (!el || !on || el.scrollHeight <= el.clientHeight) return;
    // The box is the tiles' offset parent (position: relative), so offsetTop is inside it.
    const top = on.offsetTop;
    if (top < el.scrollTop || top + on.offsetHeight > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - (el.clientHeight - on.offsetHeight) / 2);
    }
  }, [half, pair[half]]);
  return (
    <div className="ib-palrow" data-settings-palettes={half}>
      <div className="ib-prow ib-palhead">
        <span className="ib-txt">
          <span className="ib-l" id="ib-colors-label">
            Colors
          </span>
          <span className="ib-desc" data-palette-summary="">
            Light: {nameOf(pair.light)} · Dark: {nameOf(pair.dark)}. {shown === half ? 'On screen now.' : `Shows when the Inbox is ${half}.`}
          </span>
        </span>
        <span className="ib-ctl">
          <span className="ib-seg" role="radiogroup" aria-label="Choose colors for">
            {HALVES.map((choice) => (
              <label key={choice.id} className="ib-seg-o" data-on={half === choice.id ? '' : undefined}>
                <input
                  type="radio"
                  name="ib-palette-half"
                  value={choice.id}
                  checked={half === choice.id}
                  aria-label={`${choice.label} colors`}
                  onChange={() => setHalf(choice.id)}
                />
                <Icon name={choice.icon} size={14} />
                {choice.label}
              </label>
            ))}
          </span>
        </span>
      </div>
      <div ref={box} className="ib-pals" role="radiogroup" aria-label={`${halfLabel} colors`} data-palette-half={half}>
        {themes.map((theme) => {
          const on = pair[half] === theme.id;
          return (
            <label key={theme.id} className="ib-pal" data-on={on ? '' : undefined} data-palette={theme.id}>
              <input type="radio" name={`ib-palette-${half}`} value={theme.id} checked={on} onChange={() => choose(half, theme.id)} />
              <span className="ib-pal-sw" aria-hidden="true">
                {paletteSwatchColors(theme, half).map((color, i) => (
                  <span key={i} style={{ backgroundColor: color }} />
                ))}
              </span>
              <span className="ib-pal-n">{theme.name}</span>
              {on && <Icon name="check" size={14} className="ib-pal-ck" />}
            </label>
          );
        })}
      </div>
    </div>
  );
}
