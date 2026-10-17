import streamDeck, {
	action,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type KeyUpEvent,
	type SendToPluginEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { hooksStatus, installHooks } from "../hooks-install.js";
import { hostLabel, jumpTo } from "../jump.js";
import { renderEmptySlot, renderSession, toDataUri } from "../render.js";
import type { ServerStatus } from "../server.js";
import { assignKeys, type KeyAssignment, type Session, type SessionRegistry } from "../sessions.js";

type SessionSettings = {
	/** Slot fijo 1..n. Se asigna automáticamente la primera vez. */
	slot?: number;
	/** Si se indica, la tecla sigue a la sesión cuyo proyecto contenga este texto, ignorando el slot. */
	project?: string;
	/** Texto que se muestra en lugar del nombre de la carpeta. */
	label?: string;
	/** Segundos que hay que mantener la tecla para liberar el slot. */
	longPressSec?: number;
	/** Minutos tras los que "listo" vuelve solo a "en espera"; 0 = hasta pulsar. */
	doneAfterMin?: number;
	/** "te necesita" en ámbar fijo en lugar de parpadear. */
	steady?: boolean;
	/** Pulsación corta: "focus" = ir a la sesión y confirmar (por defecto); "ack" = solo confirmar. */
	pressAction?: "focus" | "ack";
};

const DEFAULT_LONG_PRESS_SEC = 1.2;

@action({ UUID: "com.aldomacias.claude-deck.session" })
export class SessionAction extends SingletonAction<SessionSettings> {
	private readonly settingsCache = new Map<string, SessionSettings>();
	private readonly pressTimers = new Map<string, NodeJS.Timeout>();
	private tick?: NodeJS.Timeout;
	private frame = 0;
	private serverStatus: ServerStatus = { listening: false, port: 0 };

	constructor(private readonly registry: SessionRegistry) {
		super();
		registry.on("change", () => void this.renderAll());
	}

	setServerStatus(status: ServerStatus): void {
		this.serverStatus = status;
		void this.renderAll();
		if (streamDeck.ui.action?.manifestId === this.manifestId) void this.sendHooksStatus();
	}

	override async onWillAppear(ev: WillAppearEvent<SessionSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		const settings = { ...ev.payload.settings };
		if (!settings.slot && !settings.project?.trim()) {
			settings.slot = this.nextFreeSlot(ev.action.id);
			await ev.action.setSettings(settings);
		}
		this.settingsCache.set(ev.action.id, settings);
		// Una tecla nueva puede quedarse una sesión que mostraba otra: se repintan todas.
		await this.renderAll();
		this.ensureTick();
	}

	override onWillDisappear(ev: WillDisappearEvent<SessionSettings>): void {
		this.settingsCache.delete(ev.action.id);
		clearTimeout(this.pressTimers.get(ev.action.id));
		this.pressTimers.delete(ev.action.id);
		if (this.settingsCache.size === 0 && this.tick) {
			clearInterval(this.tick);
			this.tick = undefined;
			return;
		}
		void this.renderAll();
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SessionSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		this.settingsCache.set(ev.action.id, ev.payload.settings);
		await this.renderAll();
	}

	override onKeyDown(ev: KeyDownEvent<SessionSettings>): void {
		const id = ev.action.id;
		const timer = setTimeout(() => {
			this.pressTimers.delete(id);
			const s = this.sessionFor(id);
			if (s) {
				this.registry.remove(s.id);
				void ev.action.showOk();
			}
		}, longPressMs(ev.payload.settings));
		this.pressTimers.set(id, timer);
	}

	override onKeyUp(ev: KeyUpEvent<SessionSettings>): void {
		const timer = this.pressTimers.get(ev.action.id);
		if (!timer) return; // ya fue pulsación larga
		clearTimeout(timer);
		this.pressTimers.delete(ev.action.id);
		const s = this.sessionFor(ev.action.id);
		if (!s) return;
		this.registry.acknowledge(s.id);
		if (ev.payload.settings.pressAction === "ack") return;
		jumpTo(s).then(
			(jumped) => {
				if (!jumped) void ev.action.showAlert(); // aún no sabemos dónde corre
			},
			(err: Error) => {
				streamDeck.logger.warn(`No se pudo ir a la sesión ${s.project}: ${err.message}`);
				void ev.action.showAlert();
			},
		);
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SessionSettings>): Promise<void> {
		const payload = ev.payload as { event?: string } | null;
		if (payload?.event === "installHooks") {
			try {
				const result = await installHooks(this.serverStatus.port || undefined);
				this.reply({ ok: true, message: result.message, backup: result.backupPath ?? "" });
			} catch (err) {
				this.reply({ ok: false, message: (err as Error).message });
			}
			return;
		}
		if (payload?.event === "hooksStatus") await this.sendHooksStatus();
	}

	private reply(data: Record<string, JsonValue>): void {
		void streamDeck.ui.sendToPropertyInspector({ event: "hooksStatus", ...data });
	}

	private async sendHooksStatus(): Promise<void> {
		const s = await hooksStatus();
		const server = this.serverStatus.listening ? `plugin escuchando en :${this.serverStatus.port}` : `servidor no activo (${this.serverStatus.error ?? "arrancando"})`;
		this.reply({ ok: s.installed, message: `${s.installed ? "Hooks instalados" : "Hooks no instalados"} — ${s.detail}. ${server}.` });
	}

	private sessionFor(actionId: string): Session | undefined {
		return assignKeys(this.settingsCache, this.registry).get(actionId)?.session;
	}

	private nextFreeSlot(exceptId: string): number {
		const used = new Set<number>();
		for (const [id, s] of this.settingsCache) if (id !== exceptId && s.slot) used.add(s.slot);
		let slot = 1;
		while (used.has(slot)) slot += 1;
		return slot;
	}

	private ensureTick(): void {
		if (this.tick) return;
		this.tick = setInterval(() => {
			this.frame += 1;
			if (this.frame % 60 === 0) this.registry.evictStale();
			if (this.settleDone()) return; // acknowledge emite "change", que ya repinta todo
			void this.renderAll(true);
		}, 1000);
	}

	/** Devuelve a "en espera" las sesiones en "listo" de las teclas que lo piden tras N minutos. */
	private settleDone(): boolean {
		const now = Date.now();
		let settled = false;
		for (const [id, { session }] of assignKeys(this.settingsCache, this.registry)) {
			const after = doneAfterMs(this.settingsCache.get(id));
			if (session?.state === "done" && after > 0 && now - session.since >= after) {
				this.registry.acknowledge(session.id);
				settled = true;
			}
		}
		return settled;
	}

	private async renderAll(onlyAnimated = false): Promise<void> {
		const assigned = assignKeys(this.settingsCache, this.registry);
		for (const a of this.actions) {
			if (!a.isKey()) continue;
			const settings = this.settingsCache.get(a.id);
			const slot = assigned.get(a.id);
			if (!settings || !slot) continue;
			if (onlyAnimated) {
				const state = slot.session?.state;
				const animated = state === "working" || state === "needs_you";
				if (!animated && this.frame % 10 !== 0) continue;
			}
			await this.render(a, settings, slot);
		}
	}

	private async render(key: KeyAction<SessionSettings>, settings: SessionSettings, slot: KeyAssignment): Promise<void> {
		const label = settings.label?.trim();
		const svg = slot.session
			? renderSession(slot.session, this.frame, { label, steady: settings.steady === true, host: hostLabel(slot.session.client) })
			: renderEmptySlot(settings.slot, this.emptyNote(settings, slot));
		await key.setImage(toDataUri(svg));
	}

	private emptyNote(settings: SessionSettings, slot: KeyAssignment): string {
		if (this.serverStatus.error) return "puerto ocupado";
		if (slot.elsewhere) return "en otra tecla";
		return truncate(settings.label?.trim() || settings.project?.trim() || "", 12);
	}
}

function longPressMs(settings: SessionSettings): number {
	const sec = Number(settings.longPressSec);
	const safe = Number.isFinite(sec) && sec > 0 ? Math.min(5, Math.max(0.3, sec)) : DEFAULT_LONG_PRESS_SEC;
	return Math.round(safe * 1000);
}

function doneAfterMs(settings: SessionSettings | undefined): number {
	const min = Number(settings?.doneAfterMin);
	return Number.isFinite(min) && min > 0 ? min * 60_000 : 0;
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
