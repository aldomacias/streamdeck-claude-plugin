import { execFile } from "node:child_process";
import type { ClientInfo, Session } from "./sessions.js";

/** Dónde corre una sesión, según lo que mandó el notificador. */
export type HostKind = "desktop" | "vscode" | "vscode-terminal" | "iterm" | "terminal" | "app" | "unknown";

export const DESKTOP_BUNDLE = "com.anthropic.claudefordesktop";
const VSCODE_BUNDLE = "com.microsoft.VSCode";
/** Esquema de URL de cada editor basado en VS Code, para el manejador de la extensión de Claude Code. */
const VSCODE_SCHEMES: Record<string, string> = {
	"com.microsoft.VSCode": "vscode",
	"com.microsoft.VSCodeInsiders": "vscode-insiders",
	"com.todesktop.230313mzl4w4u92": "cursor",
	"com.exafunction.windsurf": "windsurf",
};
/** Lo que acepta claude://code/continue?session=… en la app de escritorio. */
const HOST_SESSION_RE = /^local_[A-Za-z0-9-]{1,64}$/;
const BUNDLE_RE = /^[A-Za-z0-9.-]{1,100}$/;
/** Espera entre enfocar la ventana de VS Code y mandarle el enlace, para que lo reciba esa ventana. */
const VSCODE_FOCUS_WAIT_MS = 500;

export function hostKind(c: ClientInfo | undefined): HostKind {
	if (!c) return "unknown";
	if (c.entry === "claude-desktop" || (c.bundle === DESKTOP_BUNDLE && c.hostSession)) return "desktop";
	if (c.entry === "claude-vscode") return "vscode";
	if (c.term === "vscode") return "vscode-terminal";
	if (c.term === "iTerm.app" && c.itermSession) return "iterm";
	if (c.term === "Apple_Terminal" && c.tty) return "terminal";
	if (c.bundle && BUNDLE_RE.test(c.bundle)) return "app";
	return "unknown";
}

/** Etiqueta corta para la esquina de la tecla (cabe junto al reloj en letra grande). */
export function hostLabel(c: ClientInfo | undefined): string {
	switch (hostKind(c)) {
		case "desktop":
			return "app";
		case "vscode":
		case "vscode-terminal":
			return "VS";
		case "iterm":
			return "iTerm";
		case "terminal":
			return "Term";
		case "app":
			return (c?.term || c?.bundle?.split(".").pop() || "").slice(0, 7);
		default:
			return "";
	}
}

export type Step = { cmd: string; args: string[] } | { waitMs: number };

/** Pasos para llevarte a la sesión. Vacío = no sabemos dónde está (o no es macOS). */
export function jumpPlan(s: Session, platform: NodeJS.Platform = process.platform): Step[] {
	if (platform !== "darwin") return [];
	const c = s.client;
	const kind = hostKind(c);
	const bundle = c?.bundle && BUNDLE_RE.test(c.bundle) ? c.bundle : undefined;
	// Solo un editor de la familia VS Code recibe una ruta: nunca se abre una ruta con una app arbitraria.
	const editor = bundle && VSCODE_SCHEMES[bundle] ? bundle : VSCODE_BUNDLE;
	const folder = projectFolder(s.cwd);
	switch (kind) {
		case "desktop":
			return c?.hostSession && HOST_SESSION_RE.test(c.hostSession)
				? [{ cmd: "open", args: [`claude://code/continue?session=${c.hostSession}`] }]
				: [{ cmd: "open", args: ["-b", DESKTOP_BUNDLE] }];
		case "vscode":
			// Primero la ventana de ese proyecto, para que el enlace no abra la sesión en otra ventana.
			return [
				...(folder ? [{ cmd: "open", args: ["-b", editor, folder] }, { waitMs: VSCODE_FOCUS_WAIT_MS }] : []),
				{ cmd: "open", args: [`${VSCODE_SCHEMES[editor]}://anthropic.claude-code/open?session=${encodeURIComponent(s.id)}`] },
			];
		case "vscode-terminal":
			return [{ cmd: "open", args: folder ? ["-b", editor, folder] : ["-b", editor] }];
		case "iterm":
			return [osascript(ITERM_SCRIPT, (c?.itermSession ?? "").split(":").pop() ?? "")];
		case "terminal":
			return [osascript(TERMINAL_SCRIPT, c?.tty ?? "")];
		case "app":
			return bundle ? [{ cmd: "open", args: ["-b", bundle] }] : [];
		default:
			return [];
	}
}

/** Ejecuta el plan; `false` si no había nada que hacer. Los fallos se propagan para avisar en la tecla. */
export async function jumpTo(s: Session): Promise<boolean> {
	const steps = jumpPlan(s);
	for (const step of steps) {
		if ("waitMs" in step) await new Promise((r) => setTimeout(r, step.waitMs));
		else await run(step.cmd, step.args);
	}
	return steps.length > 0;
}

/**
 * Carpeta del proyecto para enfocar su ventana: la raíz del repo si la sesión corre en un worktree de
 * Claude (…/.claude/worktrees/<nombre>), que es la que suele estar abierta en el editor.
 */
function projectFolder(cwd: string): string | undefined {
	if (!cwd.startsWith("/")) return undefined;
	const i = cwd.indexOf("/.claude/worktrees/");
	return i > 0 ? cwd.slice(0, i) : cwd;
}

function osascript(lines: string[], arg: string): Step {
	return { cmd: "osascript", args: [...lines.flatMap((l) => ["-e", l]), arg] };
}

function run(cmd: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { timeout: 8000 }, (err, _stdout, stderr) => (err ? reject(new Error(`${cmd}: ${stderr.trim() || err.message}`)) : resolve()));
	});
}

/** Selecciona la sesión de iTerm2 cuyo id único coincide (lo que va tras ":" en ITERM_SESSION_ID). */
const ITERM_SCRIPT = [
	"on run argv",
	"set targetId to item 1 of argv",
	'tell application id "com.googlecode.iterm2"',
	"activate",
	"repeat with w in windows",
	"repeat with t in tabs of w",
	"repeat with s in sessions of t",
	"if (unique id of s) is targetId then",
	"select w",
	"select t",
	"select s",
	"return",
	"end if",
	"end repeat",
	"end repeat",
	"end repeat",
	"end tell",
	"end run",
];

/** Trae al frente la pestaña de Terminal.app con esa TTY. */
const TERMINAL_SCRIPT = [
	"on run argv",
	"set targetTty to item 1 of argv",
	'tell application id "com.apple.Terminal"',
	"activate",
	"repeat with w in windows",
	"repeat with t in tabs of w",
	"if (tty of t) is targetTty then",
	"set selected of t to true",
	"set index of w to 1",
	"return",
	"end if",
	"end repeat",
	"end repeat",
	"end tell",
	"end run",
];
