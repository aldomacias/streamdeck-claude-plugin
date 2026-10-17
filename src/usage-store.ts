import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const DEFAULT_USER_AGENT = "claude-code/2.0.31";
export const KEYCHAIN_SERVICE = "Claude Code-credentials";

export interface UsageWindow {
	/** Porcentaje 0–100 (null si el plan no lo reporta). */
	utilization: number | null;
	/** ISO 8601 del próximo reinicio. */
	resetsAt: string | null;
}

export interface UsageSnapshot {
	fiveHour: UsageWindow;
	sevenDay: UsageWindow;
	fetchedAt: number;
	raw: unknown;
}

/**
 * loading     – aún no hay dato
 * ok          – snapshot vigente
 * login       – no hay token o está vencido/rechazado → abrir Claude Code una vez
 * offline     – error de red
 * ratelimited – 429 del endpoint
 * error       – cualquier otro fallo (se conserva el último snapshot bueno)
 */
export type UsageStatus = "loading" | "ok" | "login" | "offline" | "ratelimited" | "error";

export interface UsageConfig {
	intervalMs: number;
	userAgent: string;
}

interface Credentials {
	token: string;
	expiresAt?: number;
}

/**
 * Una sola fuente de datos para todas las teclas de uso: un fetch por intervalo,
 * sin importar cuántas teclas haya. Solo lee el token (nunca lo escribe ni lo refresca).
 */
export class UsageStore extends EventEmitter {
	snapshot?: UsageSnapshot;
	status: UsageStatus = "loading";
	lastError = "";

	private timer?: NodeJS.Timeout;
	private readonly subscribers = new Set<string>();
	private config: UsageConfig = { intervalMs: 60_000, userAgent: DEFAULT_USER_AGENT };
	private failures = 0;
	private inFlight?: Promise<void>;

	configure(partial: Partial<UsageConfig>): void {
		const next = { ...this.config, ...partial };
		next.intervalMs = Math.max(15_000, next.intervalMs);
		if (!next.userAgent.startsWith("claude-code/")) next.userAgent = DEFAULT_USER_AGENT;
		const changed = next.intervalMs !== this.config.intervalMs || next.userAgent !== this.config.userAgent;
		this.config = next;
		if (changed && this.timer) this.schedule(0);
	}

	subscribe(id: string): void {
		const first = this.subscribers.size === 0;
		this.subscribers.add(id);
		if (first) this.schedule(0);
	}

	unsubscribe(id: string): void {
		this.subscribers.delete(id);
		if (this.subscribers.size === 0 && this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	refreshNow(): Promise<void> {
		return this.poll();
	}

	private schedule(delayMs: number): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.poll(), delayMs);
	}

	private async poll(): Promise<void> {
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.doPoll().finally(() => {
			this.inFlight = undefined;
			if (this.subscribers.size > 0) {
				// Backoff lineal en fallos, tope 5 min.
				const delay = this.failures > 0 ? Math.min(this.config.intervalMs * (1 + this.failures), 300_000) : this.config.intervalMs;
				this.schedule(delay);
			}
		});
		return this.inFlight;
	}

	private async doPoll(): Promise<void> {
		const creds = await readCredentials();
		if (!creds) {
			this.setStatus("login", "sin credenciales de Claude Code");
			return;
		}
		if (creds.expiresAt && creds.expiresAt < Date.now()) {
			this.setStatus("login", "token vencido");
			return;
		}
		try {
			const result = await fetchUsage(creds.token, this.config.userAgent);
			this.snapshot = result;
			this.failures = 0;
			this.setStatus("ok", "");
		} catch (err) {
			const e = err as Error & { code?: string; status?: number };
			if (e.status === 401 || e.status === 403) this.setStatus("login", `HTTP ${e.status}`);
			else if (e.status === 429) this.setStatus("ratelimited", "HTTP 429");
			else if (e.status) this.setStatus("error", `HTTP ${e.status}`);
			else this.setStatus("offline", e.message);
		}
	}

	private setStatus(status: UsageStatus, error: string): void {
		if (status !== "ok") this.failures += 1;
		this.status = status;
		this.lastError = error;
		this.emit("update", this);
	}
}

/** Token OAuth de Claude Code: Keychain en macOS, `.credentials.json` en el resto. Solo lectura. */
export async function readCredentials(): Promise<Credentials | null> {
	if (process.platform === "darwin") {
		try {
			const { stdout } = await execFileAsync("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
				timeout: 8_000,
				maxBuffer: 1024 * 1024,
			});
			const creds = parseCredentials(stdout);
			if (creds) return creds;
		} catch {
			// cae al archivo
		}
	}
	const dirs = [process.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), ".claude")].filter(Boolean) as string[];
	for (const dir of dirs) {
		try {
			const text = await fs.readFile(path.join(dir, ".credentials.json"), "utf8");
			const creds = parseCredentials(text);
			if (creds) return creds;
		} catch {
			// siguiente
		}
	}
	return null;
}

function parseCredentials(text: string): Credentials | null {
	try {
		const json = JSON.parse(text.trim()) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } };
		const token = json.claudeAiOauth?.accessToken;
		if (!token) return null;
		return { token, expiresAt: json.claudeAiOauth?.expiresAt };
	} catch {
		return null;
	}
}

export async function fetchUsage(token: string, userAgent: string): Promise<UsageSnapshot> {
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), 10_000);
	try {
		const res = await fetch(USAGE_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				"anthropic-beta": "oauth-2025-04-20",
				"User-Agent": userAgent,
				Accept: "application/json",
			},
			signal: controller.signal,
		});
		if (!res.ok) {
			const err = new Error(`HTTP ${res.status}`) as Error & { status: number };
			err.status = res.status;
			throw err;
		}
		const raw = (await res.json()) as Record<string, { utilization?: number | null; resets_at?: string | null } | undefined>;
		return {
			fiveHour: toWindow(raw.five_hour),
			sevenDay: toWindow(raw.seven_day),
			fetchedAt: Date.now(),
			raw,
		};
	} finally {
		clearTimeout(t);
	}
}

function toWindow(w?: { utilization?: number | null; resets_at?: string | null }): UsageWindow {
	return {
		utilization: typeof w?.utilization === "number" ? w.utilization : null,
		resetsAt: typeof w?.resets_at === "string" ? w.resets_at : null,
	};
}
