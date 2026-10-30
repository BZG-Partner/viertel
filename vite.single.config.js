import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Single-file build for the Kanzlei: everything — app code, CSS, fonts, icons
// and the SheetJS library — is inlined into ONE dist-single/Viertel.html. It is
// opened straight from a OneDrive/SharePoint-synced folder (file://), so no web
// server is needed. There is no service worker / PWA in this variant: a page
// opened from disk cannot register one, and updates happen by replacing the file.
//
//   npm run build:single   →   dist-single/Viertel.html

const pub = (p) => fileURLToPath(new URL('./public/' + p, import.meta.url));
const dataUri = (p, type) => `data:${type};base64,` + readFileSync(pub(p)).toString('base64');

function inlineStatics() {
  return {
    name: 'viertel-inline-statics',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        // SheetJS is a vendored UMD global; inline it as a classic script.
        // Its HTML-export strings contain "</head>", "</body>", "</html>" — the
        // single-file plugin would inject the app bundle at that first
        // "</head>" inside the library. Escaping the slash keeps the JS string
        // identical ("<\/head>" === "</head>") but invisible to HTML matching.
        const xlsx = readFileSync(pub('vendor/xlsx.full.min.js'), 'utf8')
          .replace(/<\/(script|head|body|html)/gi, '<\\/$1');
        return html
          .replace(/\s*<script type="module" src="\/src\/pwa\.js"><\/script>/, '')
          .replace('<script src="/vendor/xlsx.full.min.js"></script>', () => `<script>${xlsx}</script>`)
          .replace('href="icons/apple-touch-icon.png"', `href="${dataUri('icons/apple-touch-icon.png', 'image/png')}"`)
          .replace('href="icons/favicon-32.png"', `href="${dataUri('icons/favicon-32.png', 'image/png')}"`)
          .replace('href="icons/favicon-16.png"', `href="${dataUri('icons/favicon-16.png', 'image/png')}"`)
          .replace('href="icons/icon.svg"', `href="${dataUri('icons/icon.svg', 'image/svg+xml')}"`);
      },
    },
  };
}

export default defineConfig({
  base: './',
  publicDir: false,            // nothing is copied next to the file — it must stand alone
  build: {
    target: 'es2020',
    outDir: 'dist-single',
    emptyOutDir: true,
    sourcemap: false,
  },
  plugins: [inlineStatics(), viteSingleFile({ removeViteModuleLoader: true })],
});
