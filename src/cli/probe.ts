/**
 * Prueba fuera de Stream Deck: lee el token, llama al endpoint de uso y consulta el servidor de hooks.
 *   node bin/probe.js            → uso + sesiones
 *   node bin/probe.js --fake     → inyecta una sesión ficticia al plugin (para ver la tecla sin abrir Claude Code)
 */
import { DEFAULT_PORT } from "../server.js";
import { DEFAULT_USER_AGENT, fetchUsage, readCredentials } from "../usage-store.js";

const port = Number(process.env.CLAUDE_DECK_PORT) || DEFAULT_PORT;

async function post(ev: Record<string, unknown>, hint = ""): Promise<void> {
	const res = await fetch(`http://127.0.0.1:${port}/event${hint ? `?hint=${hint}` : ""}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(ev),
	});
	console.log(`  ${ev.hook_event_name} → HTTP ${res.status}`);
}

async function main(): Promise<void> {
	if (process.argv.includes("--fake")) {
		const session_id = `fake-${Date.now()}`;
		const cwd = `${process.env.HOME ?? "/tmp"}/proyecto-demo`;
		console.log(`Inyectando sesión ficticia ${session_id} en el puerto ${port}`);
		await post({ hook_event_name: "SessionStart", session_id, cwd, source: "startup" });
		await post({ hook_event_name: "UserPromptSubmit", session_id, cwd });
		await new Promise((r) => setTimeout(r, 2500));
		await post({ hook_event_name: "PreToolUse", session_id, cwd, tool_name: "Bash" });
		await new Promise((r) => setTimeout(r, 2500));
		await post({ hook_event_name: "PermissionRequest", session_id, cwd, tool_name: "Edit" });
		await new Promise((r) => setTimeout(r, 4000));
		await post({ hook_event_name: "PostToolUse", session_id, cwd, tool_name: "Edit" });
		await new Promise((r) => setTimeout(r, 2500));
		await post({ hook_event_name: "Stop", session_id, cwd });
		console.log("Listo: la tecla debería mostrar ✓. Pulsa la tecla para volver a 'en espera'; mantenla 1.2 s para liberar el slot.");
		return;
	}

	console.log("— Servidor de hooks —");
	try {
		const res = await fetch(`http://127.0.0.1:${port}/sessions`);
		console.log(await res.text());
	} catch (err) {
		console.log(`No responde en 127.0.0.1:${port} (¿está corriendo el plugin en Stream Deck?): ${(err as Error).message}`);
	}

	console.log("\n— Uso de Claude —");
	const creds = await readCredentials();
	if (!creds) {
		console.log("Sin credenciales: inicia sesión en Claude Code una vez (claude) y reintenta.");
		return;
	}
	// Nunca se imprime ninguna parte del token: esta salida suele pegarse en issues.
	console.log(`Token leído, vence: ${creds.expiresAt ? new Date(creds.expiresAt).toISOString() : "?"}`);
	try {
		const snap = await fetchUsage(creds.token, DEFAULT_USER_AGENT);
		console.log(JSON.stringify(snap.raw, null, 2));
	} catch (err) {
		console.log(`Fallo al consultar el endpoint: ${(err as Error).message}`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
