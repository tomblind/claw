import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TldrError } from './load.mjs'

/**
 * Find an installed Chromium-family browser instead of downloading one.
 * TEST-ONLY since the app/daemon fold: production runs the executor inside
 * the app's own webview; only the e2e harness launches a browser.
 * The probe result is cached; delete .tldr-browser.json to re-probe.
 */

const here = dirname(fileURLToPath(import.meta.url))
const CACHE = join(here, '..', '.tldr-browser.json')

function candidates() {
	const env = process.env
	switch (process.platform) {
		case 'win32':
			return [
				join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
				join(env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
				join(env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
				join(env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
				join(env.ProgramFiles ?? 'C:\\Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
			]
		case 'darwin':
			return [
				'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
				'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
				'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
				'/Applications/Arc.app/Contents/MacOS/Arc',
				'/Applications/Chromium.app/Contents/MacOS/Chromium',
			]
		default: {
			const fromWhich = []
			for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
				try {
					const p = execFileSync('which', [name], { encoding: 'utf8' }).trim()
					if (p) fromWhich.push(p)
				} catch {}
			}
			return fromWhich
		}
	}
}

export function findBrowser() {
	// cached hit from a previous probe
	try {
		const cached = JSON.parse(readFileSync(CACHE, 'utf8'))
		if (cached?.path && existsSync(cached.path)) return cached.path
	} catch {}

	for (const path of candidates()) {
		if (path && existsSync(path)) {
			try {
				writeFileSync(CACHE, JSON.stringify({ path, probed: true }))
			} catch {}
			return path
		}
	}

	throw new TldrError(
		'no Chromium-family browser found (looked for Edge, Chrome, Brave, Arc, Chromium).\n' +
			'  Options:\n' +
			'    - install Google Chrome or Microsoft Edge, then re-run\n' +
			'    - or run: npx playwright install chromium   (downloads a private copy, ~150MB)\n' +
			`    - or write the browser path into ${CACHE} as {"path": "..."}`,
		1
	)
}
