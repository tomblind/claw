/**
 * Rounded corners for convex shapes.
 *
 * tldraw's shapes have no corner radius, so claw registers a rounded variant
 * of each convex geo type whose outline is built here; the radius itself rides
 * on the shape as meta.clawRadius. Going through tldraw's own geo-type hook
 * (rather than drawing the shape ourselves) keeps every dash and fill style
 * working, including the hand-drawn look.
 */
import * as TL from 'tldraw'
import { getPolygonVertices } from '@tldraw/editor'

/**
 * Rounded boxes. tldraw's rectangle has no corner radius, so this registers a
 * custom geo type whose path is a rounded rect; the radius itself rides on the
 * shape as meta.clawRadius. Going through tldraw's own geo-type hook (rather
 * than drawing our own rect) means every dash and fill style, including the
 * hand-drawn "draw" look, keeps working untouched.
 *
 * Portability: the geo VALUE is claw-only, so files record the shape as a
 * plain "rectangle" and it is restored on load (see custom-slots.mjs). Other
 * editors therefore show an ordinary box, exactly as the radius is meant to
 * degrade.
 */
/** Corner points of each shape claw can round, matching tldraw's own paths. */
export const ROUNDABLE_VERTICES = {
	rectangle: (w, h) => [[0, 0], [w, 0], [w, h], [0, h]],
	triangle: (w, h) => [[w / 2, 0], [w, h], [0, h]],
	diamond: (w, h) => [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]],
	pentagon: (w, h) => getPolygonVertices(w, h, 5).map((p) => [p.x, p.y]),
	hexagon: (w, h) => getPolygonVertices(w, h, 6).map((p) => [p.x, p.y]),
	octagon: (w, h) => getPolygonVertices(w, h, 8).map((p) => [p.x, p.y]),
	rhombus: (w, h) => {
		const o = Math.min(w * 0.38, h * 0.38)
		return [[o, 0], [w, 0], [w - o, h], [0, h]]
	},
	'rhombus-2': (w, h) => {
		const o = Math.min(w * 0.38, h * 0.38)
		return [[0, 0], [w - o, 0], [w, h], [o, h]]
	},
	trapezoid: (w, h) => {
		const o = Math.min(w * 0.38, h * 0.38)
		return [[o, 0], [w - o, 0], [w, h], [0, h]]
	},
}

/**
 * Replace each corner of a polygon with an arc tangent to both edges.
 *
 * At a corner the arc has to start back along each edge by r/tan(angle/2),
 * which grows fast as a corner gets sharp - so the trim is clamped to half of
 * each adjacent edge and the radius recomputed from what actually fits. That
 * keeps a pointy triangle from folding in on itself at a radius that a
 * rectangle handles fine. The sweep direction comes from the sign of the turn,
 * so winding never has to be assumed.
 */
export function filletedPolygonPath(points, radius, isFilled) {
	const P = TL.PathBuilder
	const pts = points.map(([x, y]) => ({ x, y }))
	const n = pts.length
	if (!(radius > 0) || n < 3) {
		return P.lineThroughPoints(pts, { geometry: { isFilled } }).close()
	}
	const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y })
	const len = (v) => Math.hypot(v.x, v.y) || 1
	const unit = (v) => {
		const l = len(v)
		return { x: v.x / l, y: v.y / l }
	}
	const corners = []
	for (let i = 0; i < n; i++) {
		const prev = pts[(i - 1 + n) % n]
		const cur = pts[i]
		const next = pts[(i + 1) % n]
		const toPrev = unit(sub(prev, cur))
		const toNext = unit(sub(next, cur))
		const cos = Math.max(-1, Math.min(1, toPrev.x * toNext.x + toPrev.y * toNext.y))
		const angle = Math.acos(cos)
		// straight or doubled-back corner: nothing to round
		if (!Number.isFinite(angle) || angle < 0.01 || Math.PI - angle < 0.01) {
			corners.push({ start: cur, end: cur, r: 0, sweep: true })
			continue
		}
		const maxTrim = Math.min(len(sub(prev, cur)), len(sub(next, cur))) / 2
		const trim = Math.min(radius / Math.tan(angle / 2), maxTrim)
		const r = trim * Math.tan(angle / 2)
		const cross = (cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x)
		corners.push({
			start: { x: cur.x + toPrev.x * trim, y: cur.y + toPrev.y * trim },
			end: { x: cur.x + toNext.x * trim, y: cur.y + toNext.y * trim },
			r,
			sweep: cross > 0,
		})
	}
	const first = corners[0]
	const path = new P().moveTo(first.start.x, first.start.y, { geometry: { isFilled } })
	for (let i = 0; i < n; i++) {
		const c = corners[i]
		if (c.r > 0) path.circularArcTo(c.r, false, c.sweep, c.end.x, c.end.y)
		else path.lineTo(c.end.x, c.end.y)
		const nextCorner = corners[(i + 1) % n]
		path.lineTo(nextCorner.start.x, nextCorner.start.y)
	}
	return path.close()
}

