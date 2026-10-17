import type { Session, SessionState } from "./sessions.js";
import type { UsageSnapshot, UsageStatus, UsageWindow } from "./usage-store.js";

const FONT = `font-family="-apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif"`;
const SIZE = 144;

const PALETTE: Record<SessionState | "empty", { bg: string; bgAlt: string; fg: string; accent: string; label: string }> = {
	idle: { bg: "#1e1e22", bgAlt: "#1e1e22", fg: "#e7e7ea", accent: "#b4b4bc", label: "en espera" },
	working: { bg: "#2b2461", bgAlt: "#2b2461", fg: "#ffffff", accent: "#b6adff", label: "trabajando" },
	needs_you: { bg: "#8a5407", bgAlt: "#b06d0c", fg: "#ffffff", accent: "#ffe3a3", label: "te necesita" },
	done: { bg: "#14532d", bgAlt: "#14532d", fg: "#ffffff", accent: "#9ff2bd", label: "listo" },
	error: { bg: "#7f1d1d", bgAlt: "#7f1d1d", fg: "#ffffff", accent: "#ffb4b4", label: "error" },
	empty: { bg: "#141416", bgAlt: "#141416", fg: "#55555c", accent: "#3a3a40", label: "libre" },
};

export function toDataUri(svg: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`;
}

function elapsed(sinceMs: number, now = Date.now()): string {
	const total = Math.max(0, Math.floor((now - sinceMs) / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h${String(m).padStart(2, "0")}`;
	return `${m}:${String(s).padStart(2, "0")}`;
}

function wrap(bg: string, inner: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
		`<rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="20" fill="${bg}"/>${inner}</svg>`;
}

function text(x: number, y: number, size: number, fill: string, content: string, opts: { weight?: number; anchor?: "start" | "middle" | "end" } = {}): string {
	const { weight = 400, anchor = "middle" } = opts;
	return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" ${FONT}>${esc(content)}</text>`;
}

/* ───────────────────────── Sesión ───────────────────────── */

export function renderEmptySlot(slot: number | undefined, note = ""): string {
	const p = PALETTE.empty;
	return wrap(
		p.bg,
		text(72, 66, 30, p.accent, "·") +
			text(72, 100, 17, p.fg, truncate(note || (slot ? `slot ${slot}` : "sin sesión"), 13), { weight: 600 }) +
			text(72, 128, 14, p.accent, "Claude Code"),
	);
}

export interface SessionFace {
	/** Texto en lugar del nombre del proyecto; vacío = nombre de la carpeta. */
	label?: string;
	/** "te necesita" en ámbar fijo (el tono claro) en lugar de parpadear. */
	steady?: boolean;
	/** Dónde corre (app, VS Code, iTerm…), junto al número de slot. */
	host?: string;
}

export function renderSession(s: Session, frame: number, face: SessionFace = {}, now = Date.now()): string {
	const p = PALETTE[s.state];
	const bg = s.state === "needs_you" && (face.steady || frame % 2 === 1) ? p.bgAlt : p.bg;

	let glyph: string;
	switch (s.state) {
		case "working": {
			const n = (frame % 3) + 1;
			const dots = [0, 1, 2]
				.map((i) => `<circle cx="${52 + i * 20}" cy="89" r="6" fill="${i < n ? p.fg : p.accent}" opacity="${i < n ? 1 : 0.35}"/>`)
				.join("");
			glyph = dots;
			break;
		}
		case "needs_you":
			glyph = text(72, 107, 54, p.fg, "!", { weight: 700 });
			break;
		case "done":
			glyph = text(72, 105, 46, p.fg, "✓", { weight: 700 });
			break;
		case "error":
			glyph = text(72, 105, 46, p.fg, "×", { weight: 700 });
			break;
		default:
			glyph = text(72, 103, 40, p.accent, "–");
	}

	// Esquinas y pie en letra grande: en el dispositivo la tecla mide ~1,4 cm.
	const bottom = s.detail ? truncate(s.detail, 12) : p.label;
	const showClock = s.state === "working" || s.state === "needs_you";

	return wrap(
		bg,
		text(12, 26, 16, p.accent, face.host ? `S${s.slot} ${face.host}` : `S${s.slot}`, { anchor: "start", weight: 600 }) +
			(showClock ? text(132, 26, 16, p.accent, elapsed(s.since, now), { anchor: "end", weight: 600 }) : "") +
			text(72, 55, 18, p.fg, truncate(face.label || s.project, 12), { weight: 700 }) +
			glyph +
			text(72, 135, 19, p.accent, bottom, { weight: 600 }),
	);
}

/* ───────────────────────── Uso ───────────────────────── */

export interface UsageThresholds {
	amber: number;
	red: number;
}

function levelColor(pct: number | null, t: UsageThresholds): string {
	if (pct === null) return "#55555c";
	if (pct >= t.red) return "#f87171";
	if (pct >= t.amber) return "#fbbf24";
	return "#34d399";
}

function resetLabel(w: UsageWindow, now = Date.now()): string {
	if (!w.resetsAt) return "";
	const diff = new Date(w.resetsAt).getTime() - now;
	if (Number.isNaN(diff)) return "";
	if (diff <= 0) return "↻ ahora";
	const totalMin = Math.round(diff / 60_000);
	const d = Math.floor(totalMin / 1440);
	const h = Math.floor((totalMin % 1440) / 60);
	const m = totalMin % 60;
	if (d > 0) return `↻ ${d}d ${h}h`;
	if (h > 0) return `↻ ${h}h ${String(m).padStart(2, "0")}m`;
	return `↻ ${m}m`;
}

function pctText(pct: number | null): string {
	return pct === null ? "--" : `${Math.round(pct)}%`;
}

export function renderUsageStatus(status: UsageStatus, detail = ""): string {
	const bg = "#1e1e22";
	const lines: Record<UsageStatus, [string, string]> = {
		loading: ["…", "cargando"],
		login: ["abre", "Claude Code"],
		offline: ["sin red", "reintentando"],
		ratelimited: ["429", "espera un poco"],
		error: ["error", truncate(detail, 16)],
		ok: ["", ""],
	};
	const [a, b] = lines[status];
	return wrap(bg, text(72, 66, 26, "#e7e7ea", a, { weight: 700 }) + text(72, 92, 14, "#8c8c95", b) + text(72, 128, 12, "#55555c", "uso de Claude"));
}

export function renderUsageRing(w: UsageWindow, label: string, t: UsageThresholds, now = Date.now()): string {
	// Anillo algo más chico y más arriba para dejar sitio a la cuenta regresiva en letra grande.
	const r = 44;
	const cx = 72;
	const cy = 61;
	const c = 2 * Math.PI * r;
	const pct = w.utilization === null ? 0 : Math.min(100, Math.max(0, w.utilization));
	const color = levelColor(w.utilization, t);
	const ring =
		`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#2f2f35" stroke-width="10"/>` +
		(pct > 0
			? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" ` +
				`stroke-dasharray="${((c * pct) / 100).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`
			: "");
	return wrap(
		"#1e1e22",
		ring +
			text(cx, cy + 10, 29, "#ffffff", pctText(w.utilization), { weight: 700 }) +
			text(cx, cy + 28, 12, "#8c8c95", label) +
			text(72, 133, 19, "#d4d4da", resetLabel(w, now), { weight: 600 }),
	);
}

export function renderUsageBoth(snap: UsageSnapshot, t: UsageThresholds, now = Date.now()): string {
	const bar = (y: number, label: string, w: UsageWindow): string => {
		const pct = w.utilization === null ? 0 : Math.min(100, Math.max(0, w.utilization));
		const width = Math.round((120 * pct) / 100);
		return (
			text(12, y, 18, "#e7e7ea", label, { anchor: "start", weight: 700 }) +
			text(132, y, 22, levelColor(w.utilization, t), pctText(w.utilization), { anchor: "end", weight: 700 }) +
			`<rect x="12" y="${y + 7}" width="120" height="11" rx="5.5" fill="#2f2f35"/>` +
			(width > 0 ? `<rect x="12" y="${y + 7}" width="${Math.max(11, width)}" height="11" rx="5.5" fill="${levelColor(w.utilization, t)}"/>` : "")
		);
	};
	return wrap(
		"#1e1e22",
		bar(32, "5 h", snap.fiveHour) +
			bar(80, "7 d", snap.sevenDay) +
			text(72, 131, 18, "#d4d4da", `5h ${resetLabel(snap.fiveHour, now)}`, { weight: 600 }),
	);
}
