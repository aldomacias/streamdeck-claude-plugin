/**
 * Genera docs/preview.svg con todas las caras de las teclas, con datos ficticios.
 *   npx tsx scripts/make-preview.ts
 * PNG del README (macOS): qlmanage genera miniaturas cuadradas, así que se centra en un lienzo cuadrado y se recorta:
 *   sed '1s/height="324" viewBox="0 0 792 324"/height="792" viewBox="0 -234 792 792"/' docs/preview.svg > /tmp/sq.svg
 *   qlmanage -t -s 1584 -o /tmp /tmp/sq.svg && sips --cropToHeightWidth 648 1584 /tmp/sq.svg.png --out docs/preview.png
 */
import fs from "node:fs";
import path from "node:path";
import { renderEmptySlot, renderSession, renderUsageBoth, renderUsageRing, renderUsageStatus } from "../src/render.js";
import type { Session } from "../src/sessions.js";

const now = Date.now();
const t = { amber: 50, red: 80 };
const s = (over: Partial<Session>): Session => ({ id: "x", project: "web-app", cwd: "", state: "idle", detail: "", since: now - 222_000, lastEvent: now, slot: 1, turns: 1, ...over });
const inMin = (min: number): string => new Date(now + min * 60_000 + 30_000).toISOString();

const rows = [
	[
		renderSession(s({ state: "working", detail: "Bash", slot: 1 }), 1, { host: "iTerm" }, now),
		renderSession(s({ state: "needs_you", detail: "pregunta", project: "api-server", slot: 2, since: now - 95_000 }), 1, { host: "app" }, now),
		renderSession(s({ state: "done", project: "docs-site", slot: 3 }), 0, { host: "VS" }, now),
		renderSession(s({ state: "idle", project: "dashboard", slot: 4 }), 0, { host: "app" }, now),
		renderEmptySlot(5, "en otra tecla"),
	],
	[
		renderUsageBoth({ fiveHour: { utilization: 42, resetsAt: inMin(138) }, sevenDay: { utilization: 83, resetsAt: inMin(4600) }, fetchedAt: now, raw: {} }, t, now),
		renderUsageRing({ utilization: 67, resetsAt: inMin(95) }, "5 h", t, now),
		renderUsageRing({ utilization: 88, resetsAt: inMin(10_020) }, "7 d", t, now),
		renderUsageStatus("login"),
		renderEmptySlot(6),
	],
];

const KEY = 144;
const GAP = 12;
const width = 5 * KEY + 6 * GAP;
const height = rows.length * KEY + (rows.length + 1) * GAP;
const keys = rows
	.flatMap((row, r) => row.map((svg, c) => svg.replace("<svg ", `<svg x="${GAP + c * (KEY + GAP)}" y="${GAP + r * (KEY + GAP)}" `)))
	.join("\n");
const out = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" rx="18" fill="#0b0b0d"/>
${keys}
</svg>
`;
const file = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "docs", "preview.svg");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, out);
console.log(`→ ${path.relative(process.cwd(), file)}`);
