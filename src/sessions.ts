import { EventEmitter } from "node:events";
import path from "node:path";

/** Estados que puede mostrar una tecla de sesión. */
export type SessionState = "idle" | "working" | "needs_you" | "done" | "error";

export interface Session {
	id: string;
	/** Nombre de carpeta del proyecto (basename de cwd). */
	project: string;
	cwd: string;
	state: SessionState;
	/** Detalle corto: herramienta en curso, "compactando", etc. */
	detail: string;
	/** Timestamp del último cambio de estado. */
	since: number;
	lastEvent: number;
	/** Slot fijo (1..n) asignado al verla por primera vez; no cambia hasta que la sesión termina. */
	slot: number;
	turns: number;
	/** Dónde corre (app de Claude, VS Code, terminal…), según el entorno del hook. */
	client?: ClientInfo;
	/** El turno va a cerrar con una pregunta en el recuadro de siguiente paso de la app. */
	awaitingReply?: boolean;
}

/** Variables de entorno del hook que dicen dónde corre la sesión; las manda el notificador en la URL. */
export interface ClientInfo {
	/** CLAUDE_CODE_ENTRYPOINT: cli, claude-vscode, claude-desktop, sdk-ts… */
	entry?: string;
	/** __CFBundleIdentifier de la app que lanzó Claude Code (macOS). */
	bundle?: string;
	/** TERM_PROGRAM: iTerm.app, Apple_Terminal, vscode, ghostty… */
	term?: string;
	/** CLAUDE_CODE_HOST_SESSION_ID de la app de escritorio: local_… */
	hostSession?: string;
	/** ITERM_SESSION_ID: w0t1p0:<uuid>. */
	itermSession?: string;
	/** TTY de la pestaña de Terminal.app: /dev/ttys003. */
	tty?: string;
}

/** Payload que manda el hook (JSON de stdin de Claude Code) + `hint` que añade el notificador. */
export interface HookEvent {
	hook_event_name?: string;
	session_id?: string;
	cwd?: string;
	tool_name?: string;
	message?: string;
	source?: string;
	reason?: string;
	agent_id?: string;
	hint?: string;
	client?: ClientInfo;
	[k: string]: unknown;
}

/** Sesiones sin eventos en 8 h se consideran muertas (p. ej. terminal cerrada sin SessionEnd). */
const STALE_MS = 8 * 60 * 60 * 1000;

/** Herramientas que, al empezar, esperan tu respuesta aunque no pidan permiso → detalle que se muestra. */
const ASKS_YOU: Record<string, string> = { AskUserQuestion: "pregunta", ExitPlanMode: "plan" };
/** Herramienta con la que la app de escritorio cierra el turno; con `ask` te deja una pregunta pendiente. */
const WRAP_UP_TOOL = "mcp__ccd_turn__wrap_up";

/** Rastro de un evento recibido, para depurar (GET /events). Sin prompts ni entradas de herramientas. */
export interface EventRecord {
	at: string;
	session: string;
	event: string;
	tool?: string;
	hint?: string;
	/** notification_type, o "?" si el último mensaje de Claude termina en pregunta. */
	note?: string;
	subagent: boolean;
	state?: SessionState;
	detail?: string;
	keys: string[];
}

const MAX_RECENT = 300;

export class SessionRegistry extends EventEmitter {
	private readonly sessions = new Map<string, Session>();
	private readonly recent: EventRecord[] = [];

	recentEvents(): EventRecord[] {
		return [...this.recent];
	}

	private record(ev: HookEvent, s: Session | undefined): void {
		const last = typeof ev.last_assistant_message === "string" ? ev.last_assistant_message.trim() : undefined;
		const note = typeof ev.notification_type === "string" ? ev.notification_type : last?.endsWith("?") ? "?" : undefined;
		this.recent.push({
			at: new Date().toISOString(),
			session: String(ev.session_id ?? "").slice(0, 8),
			event: ev.hook_event_name ?? "",
			tool: ev.tool_name,
			hint: ev.hint,
			note,
			subagent: Boolean(ev.agent_id),
			state: s?.state,
			detail: s?.detail,
			keys: Object.keys(ev).sort(),
		});
		if (this.recent.length > MAX_RECENT) this.recent.splice(0, this.recent.length - MAX_RECENT);
	}

	list(): Session[] {
		return [...this.sessions.values()].sort((a, b) => a.slot - b.slot);
	}

	get(id: string): Session | undefined {
		return this.sessions.get(id);
	}

	bySlot(slot: number): Session | undefined {
		for (const s of this.sessions.values()) if (s.slot === slot) return s;
		return undefined;
	}

	/** Sesión más reciente cuyo nombre de proyecto contiene `name` (sin distinguir mayúsculas), salvo las de `exclude`. */
	byProject(name: string, exclude?: ReadonlySet<string>): Session | undefined {
		const needle = name.trim().toLowerCase();
		if (!needle) return undefined;
		let best: Session | undefined;
		for (const s of this.sessions.values()) {
			if (exclude?.has(s.id) || !s.project.toLowerCase().includes(needle)) continue;
			if (!best || s.lastEvent > best.lastEvent) best = s;
		}
		return best;
	}

	apply(ev: HookEvent): void {
		const id = ev.session_id;
		if (!id) return;
		const name = ev.hook_event_name ?? "";
		const now = Date.now();

		if (name === "SessionEnd") {
			this.record(ev, undefined);
			this.remove(id);
			return;
		}

		let s = this.sessions.get(id);
		if (!s) {
			s = {
				id,
				project: projectName(ev.cwd),
				cwd: ev.cwd ?? "",
				state: "idle",
				detail: "",
				since: now,
				lastEvent: now,
				slot: this.nextSlot(),
				turns: 0,
			};
			this.sessions.set(id, s);
		}
		s.lastEvent = now;
		if (ev.cwd && ev.cwd !== s.cwd) {
			s.cwd = ev.cwd;
			s.project = projectName(ev.cwd);
		}
		if (ev.client) s.client = { ...s.client, ...ev.client };

		const set = (state: SessionState, detail = ""): void => {
			if (s!.state !== state) s!.since = now;
			s!.state = state;
			s!.detail = detail;
		};

		switch (name) {
			case "SessionStart":
				set("idle", ev.source === "resume" ? "reanudada" : "");
				break;
			case "UserPromptSubmit":
				s.turns += 1;
				s.awaitingReply = false;
				set("working", "");
				break;
			case "PreToolUse": {
				const tool = String(ev.tool_name ?? "");
				// Cualquier otra herramienta después del recuadro significa que el turno siguió.
				s.awaitingReply = tool === WRAP_UP_TOOL && hasAsk(ev.tool_input);
				if (ASKS_YOU[tool]) set("needs_you", ASKS_YOU[tool]);
				else set("working", toolLabel(tool));
				break;
			}
			case "PostToolUse":
				// PostToolUse implica que el permiso (o tu respuesta) ya llegó.
				set("working", toolLabel(String(ev.tool_name ?? "")));
				break;
			case "PermissionRequest": {
				const tool = String(ev.tool_name ?? "");
				set("needs_you", ASKS_YOU[tool] ?? (tool || "permiso"));
				break;
			}
			case "Notification":
				if (ev.hint === "needs_you") {
					set("needs_you", s.state === "needs_you" ? s.detail : "pregunta");
				} else if (ev.hint === "idle" && s.state === "working") {
					// idle_prompt llega ~60 s después de que Claude terminó; si seguíamos en
					// "working" es que hubo una interrupción (Esc) sin hook: recuperamos.
					set("idle", "");
				}
				break;
			case "PreCompact":
				set("working", "compactando");
				break;
			case "PostCompact":
				set("working", "");
				break;
			case "Stop":
				if (ev.agent_id) break;
				// Stop es lo único que llega cuando Claude cierra el turno esperando tu respuesta.
				if (s.awaitingReply || endsWithQuestion(ev.last_assistant_message)) set("needs_you", "pregunta");
				else set("done", "");
				s.awaitingReply = false;
				break;
			case "StopFailure":
				set("error", "fallo de API");
				break;
			default:
				// SubagentStart/Stop y demás no cambian el estado visible.
				break;
		}
		this.record(ev, s);
		this.emit("change", s);
	}

	/** Pulsar la tecla: deja de llamar la atención. */
	acknowledge(id: string): void {
		const s = this.sessions.get(id);
		if (!s) return;
		if (s.state === "needs_you" || s.state === "done" || s.state === "error") {
			s.state = "idle";
			s.detail = "";
			s.since = Date.now();
			this.emit("change", s);
		}
	}

	remove(id: string): void {
		if (this.sessions.delete(id)) this.emit("change", undefined);
	}

	evictStale(): void {
		const cutoff = Date.now() - STALE_MS;
		let changed = false;
		for (const [id, s] of this.sessions) {
			if (s.lastEvent < cutoff) {
				this.sessions.delete(id);
				changed = true;
			}
		}
		if (changed) this.emit("change", undefined);
	}

	private nextSlot(): number {
		const used = new Set([...this.sessions.values()].map((s) => s.slot));
		let slot = 1;
		while (used.has(slot)) slot += 1;
		return slot;
	}
}

/** Qué mira una tecla: un slot fijo o, si se indica, un proyecto por nombre. */
export interface KeyTarget {
	slot?: number;
	project?: string;
}

export interface KeyAssignment {
	session?: Session;
	/** Le tocaría una sesión, pero ya se muestra en otra tecla. */
	elsewhere: boolean;
}

/**
 * Reparte las sesiones entre teclas sin repetir ninguna. Eligen primero las teclas por proyecto (la
 * sesión más reciente que coincida y siga libre) y luego las de slot. Si dos teclas apuntan a la
 * misma sesión, se la queda la primera y la otra queda vacía con `elsewhere`.
 */
export function assignKeys(keys: Iterable<[string, KeyTarget]>, registry: SessionRegistry): Map<string, KeyAssignment> {
	const entries = [...keys];
	const out = new Map<string, KeyAssignment>();
	const taken = new Set<string>();
	for (const [id, k] of entries) {
		if (!k.project?.trim()) continue;
		const session = registry.byProject(k.project, taken);
		if (session) taken.add(session.id);
		out.set(id, { session, elsewhere: !session && registry.byProject(k.project) !== undefined });
	}
	for (const [id, k] of entries) {
		if (k.project?.trim()) continue;
		const candidate = k.slot ? registry.bySlot(k.slot) : undefined;
		const session = candidate && !taken.has(candidate.id) ? candidate : undefined;
		if (session) taken.add(session.id);
		out.set(id, { session, elsewhere: candidate !== undefined && !session });
	}
	return out;
}

function hasAsk(input: unknown): boolean {
	const ask = (input as { ask?: unknown } | null | undefined)?.ask;
	return typeof ask === "string" && ask.trim() !== "";
}

/** ¿El último mensaje de Claude termina preguntándote algo? Ignora espacios y marcas finales de markdown. */
function endsWithQuestion(msg: unknown): boolean {
	return typeof msg === "string" && /\?[\s*_`"'»”)\]]*$/.test(msg);
}

/** Nombre corto para la tecla: las herramientas MCP (mcp__servidor__herramienta) muestran solo la herramienta. */
function toolLabel(tool: string): string {
	return tool.startsWith("mcp__") ? (tool.split("__").pop() ?? tool) : tool;
}

function projectName(cwd?: string): string {
	if (!cwd) return "claude";
	const base = path.basename(cwd);
	return base || "claude";
}
