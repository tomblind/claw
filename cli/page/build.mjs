/**
 * Build the self-contained editor page: one HTML file with all JS and CSS
 * inlined. Maintainer-only — run after bumping the tldraw version. The output
 * (dist/index.html) is committed/shipped so users never run this.
 *
 *   node page/build.mjs
 */
import esbuild from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const result = await esbuild.build({
	entryPoints: [join(here, 'src', 'app.jsx')],
	bundle: true,
	format: 'iife',
	write: false,
	outdir: 'out',
	minify: true,
	jsx: 'automatic',
	define: { 'process.env.NODE_ENV': '"production"' },
	// Assets tldraw's CSS references (fonts, cursors) get inlined as data URIs
	// so the single-file page has no relative-path dependencies.
	loader: {
		'.woff': 'dataurl',
		'.woff2': 'dataurl',
		'.ttf': 'dataurl',
		'.svg': 'dataurl',
		'.png': 'dataurl',
	},
	logLevel: 'warning',
})

let js = ''
let css = ''
for (const file of result.outputFiles) {
	if (file.path.endsWith('.js')) js = file.text
	else if (file.path.endsWith('.css')) css = file.text
}
if (!js) throw new Error('build produced no JS output')

// A literal </script> inside the bundle would terminate the inline script tag.
js = js.replaceAll('</script', '<\\/script')

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claw</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="116" fill="#D06A4E"/><g transform="rotate(-18 256 256)" fill="none" stroke="#fff" stroke-width="62" stroke-linecap="round"><path d="M162 118Q112 236 162 394"/><path d="M260 82Q210 246 260 430"/><path d="M358 118Q308 236 358 394"/></g></svg>'
)}">
<style>
/* tldraw.css uses var(--tl-font-ui) but (as of v5.3) never defines it, so the
   UI chrome falls back to the browser serif. Define it, apply it at the body
   so everything inherits, and force form controls to inherit too (buttons and
   inputs don't inherit fonts by default). Canvas/shape text is unaffected -
   it sets its own font families explicitly. */
:root { --tl-font-ui: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
body { font-family: var(--tl-font-ui); }
.tlui-layout :is(button, input, select, textarea) { font-family: inherit; }
${css}</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>
`

mkdirSync(join(here, 'dist'), { recursive: true })
const outPath = join(here, 'dist', 'index.html')
writeFileSync(outPath, html, 'utf8')
console.log(`wrote ${outPath} (${(html.length / 1024 / 1024).toFixed(1)} MB)`)
