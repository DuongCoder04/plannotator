import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('review entry assets', () => {
  test.each(['apps/portal/index.html', 'apps/hook/index.html', 'apps/review/index.html'])(
    '%s has no externally hosted startup scripts or styles',
    (path) => {
      expect(read(path)).not.toMatch(
        /<(?:script|link)\b[^>]*(?:src|href)=["']https?:\/\//i,
      );
    },
  );

  test('the app bundles its default fonts and syntax highlighting', () => {
    const editorCss = read('packages/editor/index.css');
    expect(editorCss).toContain('@import "@fontsource-variable/inter";');
    expect(editorCss).toContain('@import "@fontsource-variable/geist-mono";');

    const theme = read('packages/ui/themes/plannotator.css');
    expect(theme).toContain("--font-sans: 'Inter Variable'");
    expect(theme).toContain("--font-mono: 'Geist Mono Variable'");

    const codeBlock = read('packages/ui/components/blocks/CodeBlock.tsx');
    expect(codeBlock).toContain("import hljs from 'highlight.js';");
    expect(codeBlock).toContain("import 'highlight.js/styles/github-dark.css';");
  });
});

describe('marketing embeds', () => {
  const youtubePosts = [
    'apps/marketing/src/content/blog/local-diff-review-for-coding-agents.md',
    'apps/marketing/src/content/blog/plan-diff-see-what-changed.md',
    'apps/marketing/src/content/blog/plannotator-meets-pi.md',
    'apps/marketing/src/content/blog/sharing-plans-with-your-team.md',
    'apps/marketing/src/content/blog/welcome.md',
  ];

  test.each(youtubePosts)('%s uses YouTube privacy-enhanced embeds', (path) => {
    const content = read(path);
    expect(content).not.toContain('www.youtube.com/embed/');
    expect(content).toContain('www.youtube-nocookie.com/embed/');
  });

  test('the in-app help dialog uses YouTube privacy-enhanced embeds', () => {
    const toolstrip = read('packages/ui/components/AnnotationToolstrip.tsx');
    expect(toolstrip).not.toContain('www.youtube.com/embed/');
    expect(toolstrip).toContain('www.youtube-nocookie.com/embed/');
  });
});
