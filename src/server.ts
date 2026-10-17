import http from "node:http";
import type { ClientInfo, HookEvent, SessionRegistry } from "./sessions.js";

export const DEFAULT_PORT = 17875;
const MAX_BODY = 64 * 1024;

export interface ServerStatus {
	listening: boolean;
	port: number;
	error?: string;
}

type Logger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void };

const CLIENT_PARAMS: Record<string, keyof ClientInfo> = {
	entry: "entry",
	bundle: "bundle",
	term: "term",
	host: "hostSession",
	iterm: "itermSession",
	tty: "tty",
};

/** Origen de la sesión que añade el notificador a la URL; solo los campos con valor. */
export function clientFromQuery(params: URLSearchParams): ClientInfo | undefined {
	const out: ClientInfo = {};
	for (const [param, field] of Object.entries(CLIENT_PARAMS)) {
		const v = params.get(param)?.trim();
		if (v && v.length <= 200) out[field] = v;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** Puerto válido (1024–65535) o el predeterminado. Acepta el texto tal como lo guarda el inspector. */
export function parsePort(value: unknown): number {
	const n = typeof value === "string" ? Number(value.trim()) : Number(value);
	return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : DEFAULT_PORT;
}

/**
 * Receptor local de los hooks de Claude Code. Solo escucha en 127.0.0.1.
 *   POST /event?hint=<needs_you|idle>  ← JSON del hook (stdin) reenviado por claude-deck-notify.sh
 *   GET  /sessions                      ← estado actual (para depurar)
 *   GET  /events                        ← últimos 300 eventos recibidos y el estado que dejaron (para depurar)
 *   GET  /health
 *
 * Solo atiende a procesos locales (curl, node): rechaza peticiones de navegador (traen `Origin`), con un
 * `Host` que no sea este puerto en loopback (DNS rebinding) y POST que no sean JSON (evita el POST
 * "simple" sin preflight que una página web sí puede mandar).
 */
export function startHookServer(
	port: number,
	registry: SessionRegistry,
	logger: Logger,
	onStatus: (status: ServerStatus) => void,
): http.Server {
	const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
	const server = http.createServer((req, res) => {
		if (req.headers.origin !== undefined || !allowedHosts.has(req.headers.host ?? "")) {
			res.writeHead(403).end();
			return;
		}
		if (req.method === "POST" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
			res.writeHead(415).end();
			return;
		}
		const url = new URL(req.url ?? "/", "http://127.0.0.1");

		if (req.method === "GET" && url.pathname === "/health") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, sessions: registry.list().length }));
			return;
		}

		if (req.method === "GET" && url.pathname === "/events") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(registry.recentEvents(), null, 2));
			return;
		}

		if (req.method === "GET" && url.pathname === "/sessions") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(registry.list(), null, 2));
			return;
		}

		if (req.method === "POST" && url.pathname === "/event") {
			let body = "";
			let tooBig = false;
			req.on("data", (chunk: Buffer) => {
				if (tooBig) return;
				body += chunk.toString("utf8");
				if (body.length > MAX_BODY) {
					tooBig = true;
					res.writeHead(413).end();
					req.destroy();
				}
			});
			req.on("end", () => {
				if (tooBig) return;
				try {
					const ev = (body.trim() ? JSON.parse(body) : {}) as HookEvent;
					// hint y origen solo vienen de la URL (saneada por el notificador), nunca del cuerpo.
					delete ev.hint;
					delete ev.client;
					const hint = url.searchParams.get("hint");
					if (hint) ev.hint = hint;
					const client = clientFromQuery(url.searchParams);
					if (client) ev.client = client;
					registry.apply(ev);
					res.writeHead(204).end();
				} catch (err) {
					logger.warn(`Evento inválido: ${(err as Error).message}`);
					res.writeHead(400).end();
				}
			});
			return;
		}

		res.writeHead(404).end();
	});

	server.on("error", (err: NodeJS.ErrnoException) => {
		const msg = err.code === "EADDRINUSE" ? `puerto ${port} ocupado` : err.message;
		logger.error(`Servidor de hooks: ${msg}`);
		onStatus({ listening: false, port, error: msg });
	});

	server.listen(port, "127.0.0.1", () => {
		logger.info(`Servidor de hooks escuchando en http://127.0.0.1:${port}`);
		onStatus({ listening: true, port });
	});

	return server;
}
