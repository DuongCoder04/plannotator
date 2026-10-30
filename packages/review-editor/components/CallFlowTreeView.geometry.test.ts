/**
 * Guards the Call Flow tree-line geometry in every mode the stylesheet has.
 *
 * The elbow from a caller's marker into a child row is
 * `indent - toggle - marker / 2` wide. When an override makes that negative,
 * the child's toggle cell starts left of the caller's line: leaf connectors
 * cross the line, elbows vanish and chevrons sit on it. This resolves the
 * `--call-flow-*` variables the way the cascade does for each combination
 * of Dock or Lens, fine or coarse pointer, and wide or narrow viewport.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Declaration {
  readonly media: string | null;
  readonly selectors: readonly string[];
  readonly name: string;
  readonly px: number;
}

/** Every `--call-flow-*` length declared directly in a rule, in file order. */
function geometryDeclarations(css: string): Declaration[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const declarations: Declaration[] = [];
  const stack: string[] = [];
  let buffer = '';
  const flush = () => {
    const match = buffer.trim().match(/^(--call-flow-[a-z-]+)\s*:\s*([\d.]+)(px|rem)$/);
    const selector = stack[stack.length - 1];
    if (match && selector && !selector.startsWith('@')) {
      const media = [...stack].reverse().find((prelude) => prelude.startsWith('@media')) ?? null;
      declarations.push({
        media,
        selectors: selector.split(',').map((part) => part.trim()),
        name: match[1]!,
        px: Number(match[2]) * (match[3] === 'rem' ? 16 : 1),
      });
    }
    buffer = '';
  };
  for (const char of source) {
    if (char === '{') {
      stack.push(buffer.trim());
      buffer = '';
    } else if (char === '}') {
      flush();
      stack.pop();
    } else if (char === ';') {
      flush();
    } else {
      buffer += char;
    }
  }
  return declarations;
}

interface Mode {
  readonly compact: boolean;
  readonly coarse: boolean;
  readonly narrow: boolean;
}

function resolve(declarations: readonly Declaration[], mode: Mode): Map<string, number> {
  const values = new Map<string, number>();
  for (const declaration of declarations) {
    const applies = declaration.selectors.includes('.call-flow-trees')
      || (mode.compact && declaration.selectors.includes('.call-flow-trees-compact'));
    if (!applies) continue;
    if (declaration.media) {
      const active = (declaration.media.includes('pointer: coarse') && mode.coarse)
        || (declaration.media.includes('max-width') && mode.narrow);
      if (!active) continue;
    }
    // Every selector here is one class, so the later declaration wins.
    values.set(declaration.name, declaration.px);
  }
  return values;
}

const css = readFileSync(join(import.meta.dir, '..', 'index.css'), 'utf8');
const declarations = geometryDeclarations(css);
const modes: Mode[] = [];
for (const compact of [false, true]) {
  for (const coarse of [false, true]) {
    for (const narrow of [false, true]) modes.push({ compact, coarse, narrow });
  }
}

describe('Call Flow tree-line geometry', () => {
  test('the stylesheet declares the geometry the lines are drawn from', () => {
    const dock = resolve(declarations, { compact: false, coarse: false, narrow: false });
    for (const name of ['--call-flow-indent', '--call-flow-toggle', '--call-flow-marker-cell', '--call-flow-row-height']) {
      expect(dock.get(name)).toBeGreaterThan(0);
    }
  });

  for (const mode of modes) {
    const label = `${mode.compact ? 'Lens' : 'Dock'}, ${mode.coarse ? 'coarse' : 'fine'} pointer, ${mode.narrow ? 'narrow' : 'wide'}`;
    test(`a child starts right of its caller's line (${label})`, () => {
      const values = resolve(declarations, mode);
      const indent = values.get('--call-flow-indent')!;
      const toggle = values.get('--call-flow-toggle')!;
      const marker = values.get('--call-flow-marker-cell')!;
      // The elbow's width; at or below zero it collapses and the child crosses the line.
      expect(indent - toggle - marker / 2).toBeGreaterThan(0);
    });
  }
});
