import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PORT } from "./server.js";

export const NOTIFIER_NAME = "claude-deck-notify.sh";
const MARK = NOTIFIER_NAME; // cómo reconocemos nuestras entradas en settings.json

/** Script que Claude Code ejecuta en cada hook. Fire-and-forget: nunca bloquea ni falla. */
export function notifierScript(port: number): string {
	return `#!/bin/sh
# claude-deck-notify.sh — reenvía el JSON del hook de Claude Code al plugin de Stream Deck.
# Generado por el plugin claude-deck. Nunca bloquea: timeout de 1 s y siempre sale con 0.
PORT="\${CLAUDE_DECK_PORT:-${port}}"
HINT="\${1:-}"
PAYLOAD="$(cat 2>/dev/null)"
[ -z "$PAYLOAD" ] && exit 0
# Dónde corre la sesión, para que la tecla te lleve a ella. Solo caracteres seguros para la URL.
q() { printf %s "$1" | tr -cd 'A-Za-z0-9._:/-'; }
TTY=""
if [ "$TERM_PROGRAM" = "Apple_Terminal" ]; then
  P="$PPID"
  for _ in 1 2 3; do
    T="$(ps -o tty= -p "$P" 2>/dev/null | tr -d ' ')"
    case "$T" in
      ""|"??") P="$(ps -o ppid= -p "$P" 2>/dev/null | tr -d ' ')"; [ -n "$P" ] || break ;;
      *) TTY="/dev/$T"; break ;;
    esac
  done
fi
QS="hint=$(q "$HINT")&entry=$(q "$CLAUDE_CODE_ENTRYPOINT")&bundle=$(q "$__CFBundleIdentifier")&term=$(q "$TERM_PROGRAM")&host=$(q "$CLAUDE_CODE_HOST_SESSION_ID")&iterm=$(q "$ITERM_SESSION_ID")&tty=$(q "$TTY")"
curl -s -o /dev/null --max-time 1 -X POST "http://127.0.0.1:\${PORT}/event?\${QS}" \\
  -H 'Content-Type: application/json' --data-binary "$PAYLOAD" >/dev/null 2>&1 || true
exit 0
`;
}

type HookHandler = { type: "command"; command: string; async?: boolean; timeout?: number };
type HookGroup = { matcher?: string; hooks: HookHandler[] };
type Settings = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

function handler(script: string, arg = ""): HookHandler {
	return { type: "command", command: arg ? `${script} ${arg}` : script, async: true, timeout: 5 };
}

/** Eventos que alimentan el estado de la tecla. */
export function desiredHooks(script: string): Record<string, HookGroup[]> {
	const plain = (): HookGroup[] => [{ hooks: [handler(script)] }];
	return {
		SessionStart: plain(),
		UserPromptSubmit: plain(),
		PreToolUse: [{ matcher: "", hooks: [handler(script)] }],
		PostToolUse: [{ matcher: "", hooks: [handler(script)] }],
		PermissionRequest: [{ matcher: "", hooks: [handler(script)] }],
		Notification: [
			{ matcher: "permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input", hooks: [handler(script, "needs_you")] },
			{ matcher: "idle_prompt", hooks: [handler(script, "idle")] },
		],
		PreCompact: [{ matcher: "", hooks: [handler(script)] }],
		PostCompact: plain(),
		Stop: plain(),
		StopFailure: plain(),
		SessionEnd: [{ matcher: "", hooks: [handler(script)] }],
	};
}

export interface InstallResult {
	ok: boolean;
	message: string;
	settingsPath: string;
	scriptPath: string;
	backupPath?: string;
}

export function claudeDir(): string {
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function stripOurs(settings: Settings): Settings {
	const hooks = settings.hooks ?? {};
	const cleaned: Record<string, HookGroup[]> = {};
	for (const [event, groups] of Object.entries(hooks)) {
		const kept = (groups ?? [])
			.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !(h.type === "command" && typeof h.command === "string" && h.command.includes(MARK))) }))
			.filter((g) => g.hooks.length > 0);
		if (kept.length > 0) cleaned[event] = kept;
	}
	const out: Settings = { ...settings };
	if (Object.keys(cleaned).length > 0) out.hooks = cleaned;
	else delete out.hooks;
	return out;
}

async function readSettings(file: string): Promise<Settings> {
	try {
		const text = await fs.readFile(file, "utf8");
		if (!text.trim()) return {};
		const parsed = JSON.parse(text) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("settings.json no es un objeto JSON");
		return parsed as Settings;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`No se pudo leer ${file}: ${(err as Error).message}`);
	}
}

async function writeSettings(file: string, settings: Settings): Promise<string | undefined> {
	let backup: string | undefined;
	try {
		await fs.access(file);
		backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
		await fs.copyFile(file, backup);
	} catch {
		// no había archivo
	}
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
	return backup;
}

/** Instala (o reinstala) el notificador y las entradas de hooks en ~/.claude/settings.json. Idempotente. */
export async function installHooks(port = DEFAULT_PORT): Promise<InstallResult> {
	const dir = claudeDir();
	const settingsPath = path.join(dir, "settings.json");
	const scriptPath = path.join(dir, "hooks", NOTIFIER_NAME);

	await fs.mkdir(path.dirname(scriptPath), { recursive: true });
	await fs.writeFile(scriptPath, notifierScript(port), { encoding: "utf8", mode: 0o755 });
	await fs.chmod(scriptPath, 0o755);

	const current = stripOurs(await readSettings(settingsPath));
	const merged: Settings = { ...current, hooks: { ...(current.hooks ?? {}) } };
	for (const [event, groups] of Object.entries(desiredHooks(scriptPath))) {
		merged.hooks![event] = [...(merged.hooks![event] ?? []), ...groups];
	}
	const backupPath = await writeSettings(settingsPath, merged);
	return {
		ok: true,
		message: `Hooks instalados en ${settingsPath}. Reinicia las sesiones de Claude Code abiertas (o usa /hooks) para que los tomen.`,
		settingsPath,
		scriptPath,
		backupPath,
	};
}

/**
 * Si el notificador ya está instalado, lo reescribe con `port` (solo si cambió). settings.json apunta al
 * script por ruta, así que las sesiones abiertas de Claude Code lo usan desde el siguiente hook.
 */
export async function syncNotifierPort(port: number): Promise<boolean> {
	const scriptPath = path.join(claudeDir(), "hooks", NOTIFIER_NAME);
	let current: string;
	try {
		current = await fs.readFile(scriptPath, "utf8");
	} catch {
		return false; // no instalado: no creamos nada
	}
	const next = notifierScript(port);
	if (current === next) return false;
	// Escribe aparte y renombra: un hook que arranque a la mitad nunca ve el script a medias.
	const tmp = `${scriptPath}.tmp-${process.pid}`;
	await fs.writeFile(tmp, next, { encoding: "utf8", mode: 0o755 });
	await fs.chmod(tmp, 0o755);
	await fs.rename(tmp, scriptPath);
	return true;
}

export async function uninstallHooks(): Promise<InstallResult> {
	const dir = claudeDir();
	const settingsPath = path.join(dir, "settings.json");
	const scriptPath = path.join(dir, "hooks", NOTIFIER_NAME);
	const current = await readSettings(settingsPath);
	const cleaned = stripOurs(current);
	const backupPath = await writeSettings(settingsPath, cleaned);
	try {
		await fs.unlink(scriptPath);
	} catch {
		// ya no estaba
	}
	return { ok: true, message: `Hooks de claude-deck eliminados de ${settingsPath}.`, settingsPath, scriptPath, backupPath };
}

/** ¿Están instalados nuestros hooks (al menos SessionStart y Stop) y existe el script? */
export async function hooksStatus(): Promise<{ installed: boolean; detail: string }> {
	const dir = claudeDir();
	const settingsPath = path.join(dir, "settings.json");
	const scriptPath = path.join(dir, "hooks", NOTIFIER_NAME);
	let scriptOk = false;
	try {
		await fs.access(scriptPath);
		scriptOk = true;
	} catch {
		// falta
	}
	let settings: Settings = {};
	try {
		settings = await readSettings(settingsPath);
	} catch (err) {
		return { installed: false, detail: (err as Error).message };
	}
	const events = Object.entries(settings.hooks ?? {})
		.filter(([, groups]) => (groups ?? []).some((g) => (g.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(MARK))))
		.map(([event]) => event);
	const installed = scriptOk && events.includes("SessionStart") && events.includes("Stop");
	return {
		installed,
		detail: installed ? `${events.length} eventos conectados` : scriptOk ? "faltan entradas en settings.json" : "falta el script notificador",
	};
}
