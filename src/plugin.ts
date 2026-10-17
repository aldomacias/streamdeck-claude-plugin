import type http from "node:http";
import streamDeck from "@elgato/streamdeck";
import { SessionAction } from "./actions/session.js";
import { UsageAction } from "./actions/usage.js";
import { syncNotifierPort } from "./hooks-install.js";
import { parsePort, startHookServer } from "./server.js";
import { SessionRegistry } from "./sessions.js";
import { UsageStore } from "./usage-store.js";

type GlobalSettings = { port?: number | string };

/** El inspector guarda el puerto mientras escribes; se espera a que dejes de teclear antes de reabrir. */
const PORT_DEBOUNCE_MS = 1500;

streamDeck.logger.setLevel("info");

const registry = new SessionRegistry();
const store = new UsageStore();
const sessionAction = new SessionAction(registry);

streamDeck.actions.registerAction(sessionAction);
streamDeck.actions.registerAction(new UsageAction(store));

let server: http.Server | undefined;
let serverPort = 0;
let serverFailed = false;
let generation = 0;
let pendingPort: NodeJS.Timeout | undefined;

/** Abre el servidor de hooks en `port` cerrando el anterior; al quedar escuchando, alinea el notificador. */
function listen(port: number): void {
	if (server && port === serverPort && !serverFailed) return;
	const gen = ++generation;
	const prev = server;
	serverPort = port;
	serverFailed = false;
	const start = (): void => {
		if (gen !== generation) return;
		server = startHookServer(port, registry, streamDeck.logger, (status) => {
			if (gen !== generation) return;
			serverFailed = !status.listening;
			sessionAction.setServerStatus(status);
			if (!status.listening) return;
			syncNotifierPort(port).then(
				(updated) => {
					if (updated) streamDeck.logger.info(`Notificador actualizado al puerto ${port}`);
				},
				(err: Error) => streamDeck.logger.warn(`No se pudo actualizar el notificador: ${err.message}`),
			);
		});
	};
	if (!prev) {
		start();
		return;
	}
	prev.close(() => start());
	prev.closeAllConnections();
}

streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
	clearTimeout(pendingPort);
	pendingPort = setTimeout(() => listen(parsePort(ev.settings.port)), PORT_DEBOUNCE_MS);
});

await streamDeck.connect();

const globals = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
listen(parsePort(globals.port));
