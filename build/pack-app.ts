import { extname } from 'node:path';
import type { Plugin } from 'vite';
import { packApp, PACKED_ASSET_ROUTE_PREFIX, type PackedAsset } from '../packages/shared/packed-app';

/**
 * Every file type the app builds emit. A new one fails the build loudly rather
 * than being served with a guessed type.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

/**
 * Said when the page cannot load its own chunks. That happens when a server
 * from before the pack serves this file whole (a Pi or Oh My Pi session that
 * reads it after an in-place update): its fallback answers `/assets/*` with
 * the page, so the entry script never runs. A lazy chunk that fails while the
 * entry is no longer served as JavaScript means the same thing (a server of
 * another version); while the entry still loads, the failure is the app's to
 * handle, and a network error (the session ended) says nothing.
 * Inline and plain, because the app's own code and CSS are what failed; when
 * the entry failed the message is the whole page, so the page follows the
 * system's light or dark scheme.
 */
export const UPDATED_WHILE_OPEN_MESSAGE =
  'Plannotator was updated while this session was open. Run /reload in Pi (or /restart in Oh My Pi), or restart your agent, to finish.';

const UPDATED_WHILE_OPEN_SCRIPT = `<script>(function(){
var shown=false;
function show(page){if(page)document.documentElement.style.colorScheme="light dark";if(shown)return;shown=true;var p=document.createElement("p");p.setAttribute("role","alert");p.id="plannotator-updated";p.textContent=${JSON.stringify(UPDATED_WHILE_OPEN_MESSAGE)};p.style.cssText="position:fixed;top:0;left:0;right:0;margin:0;padding:12px 16px;font:14px/1.5 system-ui,sans-serif;color-scheme:light dark;background:Canvas;color:CanvasText;z-index:2147483647";(document.body||document.documentElement).prepend(p)}
function entry(){return document.querySelector('script[type="module"][src^="/assets/"]')}
addEventListener("error",function(e){if(e.target===entry())show(true)},true);
addEventListener("vite:preloadError",function(){var s=entry();if(s)fetch(s.src,{method:"HEAD",cache:"no-store"}).then(function(r){if(!r.ok||!/javascript/.test(r.headers.get("content-type")||""))show()},function(){})});
})()</script>`;

/**
 * Emit the app as one `index.html` that carries its code-split chunks and
 * assets behind a marker, where vite-plugin-singlefile inlined all of them into
 * the page. The servers serve both halves; see packages/shared/packed-app.ts.
 */
export function packedApp(): Plugin {
  return {
    name: 'plannotator-packed-app',
    enforce: 'post',
    // Last in the hook, not merely a post plugin: Vite's own post build
    // plugins still rewrite the chunks here (vite:build-import-analysis fills
    // in the __VITE_PRELOAD__ dependency lists), so packing any earlier ships
    // chunks that throw on their first dynamic import.
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const page = bundle['index.html'];
        if (page?.type !== 'asset' || typeof page.source !== 'string') {
          throw new Error('packed-app: the build emitted no index.html');
        }
        const assets: Record<string, PackedAsset> = {};
        for (const output of Object.values(bundle)) {
          if (output === page) continue;
          const type = CONTENT_TYPES[extname(output.fileName)];
          if (!type) throw new Error(`packed-app: no content type for ${output.fileName}`);
          // The servers answer packed files under this prefix only.
          const path = `/${output.fileName}`;
          if (!path.startsWith(PACKED_ASSET_ROUTE_PREFIX)) throw new Error(`packed-app: ${output.fileName} is outside ${PACKED_ASSET_ROUTE_PREFIX}`);
          const source = output.type === 'chunk' ? output.code : output.source;
          assets[path] = typeof source === 'string'
            ? { type, text: source }
            : { type, base64: Buffer.from(source).toString('base64') };
          delete bundle[output.fileName];
        }
        if (!page.source.includes('</head>')) throw new Error('packed-app: index.html has no </head>');
        page.source = packApp(page.source.replace('</head>', `${UPDATED_WHILE_OPEN_SCRIPT}\n  </head>`), assets);
      },
    },
  };
}
