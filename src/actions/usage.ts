import {
	action,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyUpEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import { renderUsageBoth, renderUsageRing, renderUsageStatus, toDataUri, type UsageThresholds } from "../render.js";
import type { UsageStore } from "../usage-store.js";

type Metric = "both" | "session" | "weekly";

type UsageSettings = {
	metric?: Metric;
	/** Segundos entre consultas (mín. 15). */
	intervalSec?: number;
	amber?: number;
	red?: number;
	/** Debe empezar por "claude-code/". */
	userAgent?: string;
};

@action({ UUID: "com.aldomacias.claude-deck.usage" })
export class UsageAction extends SingletonAction<UsageSettings> {
	private readonly settingsCache = new Map<string, UsageSettings>();
	private tick?: NodeJS.Timeout;

	constructor(private readonly store: UsageStore) {
		super();
		store.on("update", () => void this.renderAll());
	}

	override async onWillAppear(ev: WillAppearEvent<UsageSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		this.settingsCache.set(ev.action.id, ev.payload.settings);
		this.applyConfig();
		this.store.subscribe(ev.action.id);
		await this.render(ev.action, ev.payload.settings);
		if (!this.tick) this.tick = setInterval(() => void this.renderAll(), 30_000);
	}

	override onWillDisappear(ev: WillDisappearEvent<UsageSettings>): void {
		this.settingsCache.delete(ev.action.id);
		this.store.unsubscribe(ev.action.id);
		if (this.settingsCache.size === 0 && this.tick) {
			clearInterval(this.tick);
			this.tick = undefined;
		}
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<UsageSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		this.settingsCache.set(ev.action.id, ev.payload.settings);
		this.applyConfig();
		await this.render(ev.action, ev.payload.settings);
	}

	/** Pulsar = refrescar ahora. */
	override async onKeyUp(ev: KeyUpEvent<UsageSettings>): Promise<void> {
		await this.store.refreshNow();
	}

	/** El intervalo más corto y el User-Agent configurados en cualquier tecla mandan. */
	private applyConfig(): void {
		let intervalMs = 60_000;
		let userAgent: string | undefined;
		for (const s of this.settingsCache.values()) {
			if (s.intervalSec) intervalMs = Math.min(intervalMs, s.intervalSec * 1000);
			if (s.userAgent?.trim()) userAgent = s.userAgent.trim();
		}
		this.store.configure(userAgent ? { intervalMs, userAgent } : { intervalMs });
	}

	private async renderAll(): Promise<void> {
		for (const a of this.actions) {
			if (!a.isKey()) continue;
			const settings = this.settingsCache.get(a.id);
			if (settings) await this.render(a, settings);
		}
	}

	private async render(key: KeyAction<UsageSettings>, settings: UsageSettings): Promise<void> {
		const t: UsageThresholds = { amber: settings.amber ?? 50, red: settings.red ?? 80 };
		const snap = this.store.snapshot;
		let svg: string;
		if (!snap) {
			svg = renderUsageStatus(this.store.status, this.store.lastError);
		} else if (this.store.status === "login") {
			svg = renderUsageStatus("login");
		} else {
			switch (settings.metric ?? "both") {
				case "session":
					svg = renderUsageRing(snap.fiveHour, "5 h", t);
					break;
				case "weekly":
					svg = renderUsageRing(snap.sevenDay, "7 d", t);
					break;
				default:
					svg = renderUsageBoth(snap, t);
			}
		}
		await key.setImage(toDataUri(svg));
	}
}
