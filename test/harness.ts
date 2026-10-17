/**
 * Prueba de integración fuera de Stream Deck:
 *   1. servidor de hooks + registro de sesiones (estados)
 *   2. notificador .sh real (curl) contra el servidor
 *   3. instalador de hooks en un ~/.claude temporal (idempotencia + desinstalación)
 *   4. render de todas las caras → SVG en test/out/ (para rasterizar y mirar)
 * Ejecutar: npx tsx test/harness.ts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { desiredHooks, hooksStatus, installHooks, notifierScript, syncNotifierPort, uninstallHooks } from "../src/hooks-install.js";
import { renderEmptySlot, renderSession, renderUsageBoth, renderUsageRing, renderUsageStatus } from "../src/render.js";
import { hostKind, hostLabel, jumpPlan } from "../src/jump.js";
import { clientFromQuery, DEFAULT_PORT, parsePort, startHookServer } from "../src/server.js";
import { assignKeys, type ClientInfo, type KeyTarget, SessionRegistry, type Session } from "../src/sessions.js";

const PORT = 17999;
const log = { info: (m: string) => console.log("  [srv]", m), warn: (m: string) => console.log("  [srv!]", m), error: (m: string) => console.log("  [srv✕]", m) };


/** Ejecuta el notificador como lo haría Claude Code: stdin con el JSON, sin bloquear el event loop. */
function runNotifier(script: string, hint: string, payload: string, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; ms: number }> {
	return new Promise((resolve) => {
		const t0 = Date.now();
		// Entorno mínimo: que no se cuele el de la sesión que corre las pruebas.
		const child = spawn("sh", hint ? [script, hint] : [script], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } });
		let stdout = "";
		child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
		child.on("close", (code) => resolve({ code, stdout, ms: Date.now() - t0 }));
		child.stdin.end(payload);
	});
}

async function post(ev: Record<string, unknown>, hint = ""): Promise<number> {
	const res = await fetch(`http://127.0.0.1:${PORT}/event${hint ? `?hint=${hint}` : ""}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(ev),
	});
	return res.status;
}

async function main(): Promise<void> {
	console.log("1. servidor + estados");
	const registry = new SessionRegistry();
	const server = startHookServer(PORT, registry, log, () => {});
	await new Promise((r) => server.once("listening", r));

	const a = { session_id: "A", cwd: "/Users/me/code/web-app" };
	const b = { session_id: "B", cwd: "/Users/me/code/docs-site" };
	assert.equal(await post({ ...a, hook_event_name: "SessionStart", source: "startup" }), 204);
	assert.equal(registry.bySlot(1)?.state, "idle");
	assert.equal(registry.bySlot(1)?.project, "web-app");
	await post({ ...b, hook_event_name: "SessionStart", source: "startup" });
	assert.equal(registry.bySlot(2)?.project, "docs-site");

	await post({ ...a, hook_event_name: "UserPromptSubmit" });
	assert.equal(registry.get("A")?.state, "working");
	await post({ ...a, hook_event_name: "PreToolUse", tool_name: "Bash" });
	assert.equal(registry.get("A")?.detail, "Bash");
	await post({ ...a, hook_event_name: "PermissionRequest", tool_name: "Edit" });
	assert.equal(registry.get("A")?.state, "needs_you");
	await post({ ...a, hook_event_name: "PostToolUse", tool_name: "Edit" });
	assert.equal(registry.get("A")?.state, "working");
	await post({ ...a, hook_event_name: "Notification", message: "Claude needs your permission" }, "needs_you");
	assert.equal(registry.get("A")?.state, "needs_you");
	await post({ ...a, hook_event_name: "Stop", last_assistant_message: "hecho" });
	assert.equal(registry.get("A")?.state, "done");
	registry.acknowledge("A");
	assert.equal(registry.get("A")?.state, "idle");
	await post({ ...b, hook_event_name: "UserPromptSubmit" });
	await post({ ...b, hook_event_name: "Notification" }, "idle"); // recuperación tras Esc
	assert.equal(registry.get("B")?.state, "idle");
	await post({ ...b, hook_event_name: "StopFailure" });
	assert.equal(registry.get("B")?.state, "error");
	assert.equal(registry.byProject("docs")?.id, "B");
	await post({ ...a, hook_event_name: "SessionEnd", reason: "other" });
	assert.equal(registry.get("A"), undefined);
	// el slot 1 queda libre y lo toma la siguiente sesión nueva
	await post({ session_id: "C", cwd: "/tmp/otro", hook_event_name: "SessionStart" });
	assert.equal(registry.get("C")?.slot, 1);
	assert.equal(await post({ hook_event_name: "Stop" }), 204); // sin session_id: se ignora sin romper
	// solo procesos locales: un navegador (Origin), un Host ajeno (DNS rebinding) o un POST sin JSON se rechazan
	const raw = (init: { method?: string; headers?: Record<string, string>; body?: string; path?: string }): Promise<number> =>
		new Promise((resolve, reject) => {
			const req = http.request({ host: "127.0.0.1", port: PORT, path: init.path ?? "/event", method: init.method ?? "POST", headers: init.headers }, (res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			});
			req.on("error", reject);
			req.end(init.body);
		});
	const fake = JSON.stringify({ session_id: "X", hook_event_name: "SessionStart", cwd: "/tmp/x" });
	assert.equal(await raw({ headers: { "Content-Type": "text/plain", Origin: "https://evil.example" }, body: fake }), 403, "navegador");
	assert.equal(await raw({ headers: { "Content-Type": "application/json", Origin: "null" }, body: fake }), 403, "Origin null");
	assert.equal(await raw({ headers: { "Content-Type": "text/plain" }, body: fake }), 415, "POST sin JSON");
	assert.equal(await raw({ headers: { "Content-Type": "application/json", Host: "evil.example:17999" }, body: fake }), 403, "DNS rebinding");
	assert.equal(await raw({ method: "GET", path: "/sessions", headers: { Host: "evil.example" } }), 403, "lectura con Host ajeno");
	assert.equal(await raw({ headers: { "Content-Type": "application/json", Host: `localhost:${PORT}` }, body: JSON.stringify({ session_id: "X", hook_event_name: "SessionEnd" }) }), 204, "localhost vale");
	assert.equal(registry.get("X"), undefined, "nada rechazado llegó al registro");
	await post({ session_id: "Y", hook_event_name: "SessionStart", cwd: "/tmp/y", client: { bundle: "com.apple.Terminal", entry: "cli" } });
	assert.equal(registry.get("Y")?.client, undefined, "el origen solo viene de la URL saneada, no del cuerpo");
	await post({ session_id: "Y", hook_event_name: "SessionEnd" });
	console.log("   ✓ servidor: rechaza navegador, Host ajeno, POST sin JSON y origen en el cuerpo");

	const health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
	assert.equal((health as { sessions: number }).sessions, 2);
	console.log("   ✓ estados, slots fijos, byProject, recuperación idle, SessionEnd");

	// preguntas y plan: esperan tu respuesta aunque no pidan permiso
	const d = { session_id: "D", cwd: "/Users/me/code/web-app-api" };
	await post({ ...d, hook_event_name: "UserPromptSubmit" });
	await post({ ...d, hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" });
	assert.equal(registry.get("D")?.state, "needs_you");
	assert.equal(registry.get("D")?.detail, "pregunta");
	await post({ ...d, hook_event_name: "PostToolUse", tool_name: "AskUserQuestion" });
	assert.equal(registry.get("D")?.state, "working");
	await post({ ...d, hook_event_name: "PreToolUse", tool_name: "ExitPlanMode" });
	assert.equal(registry.get("D")?.state, "needs_you");
	await post({ ...d, hook_event_name: "PermissionRequest", tool_name: "ExitPlanMode" });
	assert.equal(registry.get("D")?.detail, "plan");
	console.log("   ✓ AskUserQuestion / ExitPlanMode → te necesita");

	// fin de turno esperando respuesta: solo llega Stop, y no debe quedar en "listo"
	const e = { session_id: "E", cwd: "/Users/me/code/dashboard" };
	await post({ ...e, hook_event_name: "UserPromptSubmit" });
	await post({ ...e, hook_event_name: "PreToolUse", tool_name: "mcp__ccd_turn__wrap_up", tool_input: { recap: "Hecho.", ask: "¿Empaco el plugin?" } });
	await post({ ...e, hook_event_name: "PostToolUse", tool_name: "mcp__ccd_turn__wrap_up", tool_input: { recap: "Hecho.", ask: "¿Empaco el plugin?" } });
	await post({ ...e, hook_event_name: "Stop", last_assistant_message: "" });
	assert.equal(registry.get("E")?.state, "needs_you", "recuadro de la app con pregunta → te necesita");
	assert.equal(registry.get("E")?.detail, "pregunta");
	await post({ ...e, hook_event_name: "UserPromptSubmit" });
	await post({ ...e, hook_event_name: "PreToolUse", tool_name: "mcp__ccd_turn__wrap_up", tool_input: { recap: "Hecho." } });
	await post({ ...e, hook_event_name: "Stop", last_assistant_message: "Listo, instalado." });
	assert.equal(registry.get("E")?.state, "done", "recuadro sin pregunta → listo");
	for (const msg of ["¿Lo empaco e instalo?", "Hecho. ¿Sigo con la 2?**", "¿Cuál prefieres? (A o B)?\n\n"]) {
		await post({ ...e, hook_event_name: "UserPromptSubmit" });
		await post({ ...e, hook_event_name: "Stop", last_assistant_message: msg });
		assert.equal(registry.get("E")?.state, "needs_you", `termina en pregunta: ${JSON.stringify(msg)}`);
	}
	await post({ ...e, hook_event_name: "UserPromptSubmit" });
	await post({ ...e, hook_event_name: "Stop", last_assistant_message: "¿Por qué fallaba? Porque faltaba el puerto. Ya quedó." });
	assert.equal(registry.get("E")?.state, "done", "pregunta en medio, no al final → listo");
	await post({ ...e, hook_event_name: "SessionEnd" });
	console.log("   ✓ fin de turno con pregunta (recuadro de la app o texto) → te necesita");

	// reparto de teclas: C=slot 1, B=slot 2, D=slot 3 (web-app-api)
	assert.equal(registry.get("D")?.slot, 3);
	const asg = assignKeys(
		new Map<string, KeyTarget>([
			["k1", { slot: 1 }],
			["k3", { slot: 3 }],
			["kp", { project: "api" }],
			["kp2", { project: "API" }],
			["k1b", { slot: 1 }],
			["k9", { slot: 9 }],
		]),
		registry,
	);
	assert.equal(asg.get("kp")?.session?.id, "D", "la tecla por proyecto se queda la sesión");
	assert.equal(asg.get("k3")?.session, undefined, "y su tecla de slot no la repite");
	assert.equal(asg.get("k3")?.elsewhere, true);
	assert.equal(asg.get("kp2")?.session, undefined, "dos teclas por proyecto no repiten sesión");
	assert.equal(asg.get("kp2")?.elsewhere, true);
	assert.equal(asg.get("k1")?.session?.id, "C");
	assert.equal(asg.get("k1b")?.session, undefined, "slot repetido: solo la primera tecla");
	assert.equal(asg.get("k9")?.session, undefined);
	assert.equal(asg.get("k9")?.elsewhere, false);
	assert.equal(registry.byProject("api", new Set(["D"])), undefined);
	console.log("   ✓ una sesión nunca aparece en dos teclas");

	assert.equal(parsePort("18000"), 18000);
	assert.equal(parsePort(" 18000 "), 18000);
	assert.equal(parsePort(17999), 17999);
	for (const bad of ["", "abc", "80", "70000", "1800.5", undefined, null]) assert.equal(parsePort(bad), DEFAULT_PORT, `puerto ${String(bad)}`);
	console.log("   ✓ parsePort");

	// a dónde lleva cada tecla
	assert.equal(clientFromQuery(new URLSearchParams("hint=idle&entry=&tty=")), undefined);
	const sess = (id: string, cwd: string, client?: ClientInfo): Session => ({ id, project: "p", cwd, state: "idle", detail: "", since: 0, lastEvent: 0, slot: 1, turns: 0, client });
	const desk = clientFromQuery(new URLSearchParams("entry=claude-desktop&bundle=com.anthropic.claudefordesktop&host=local_0a1b2c3d-test"));
	assert.equal(hostKind(desk), "desktop");
	assert.equal(hostLabel(desk), "app");
	assert.deepEqual(jumpPlan(sess("sess-1", "/x", desk), "darwin"), [{ cmd: "open", args: ["claude://code/continue?session=local_0a1b2c3d-test"] }]);
	assert.deepEqual(jumpPlan(sess("sess-1", "/x", { entry: "claude-desktop", hostSession: "local_x&y" }), "darwin"), [{ cmd: "open", args: ["-b", "com.anthropic.claudefordesktop"] }], "id raro → solo abre la app");
	assert.deepEqual(jumpPlan(sess("sess-1", "/x", desk), "win32"), [], "fuera de macOS no hace nada");
	assert.deepEqual(jumpPlan(sess("abc-123", "/Users/me/code/app/.claude/worktrees/fix", { entry: "claude-vscode", bundle: "com.microsoft.VSCode" }), "darwin"), [
		{ cmd: "open", args: ["-b", "com.microsoft.VSCode", "/Users/me/code/app"] },
		{ waitMs: 500 },
		{ cmd: "open", args: ["vscode://anthropic.claude-code/open?session=abc-123"] },
	]);
	assert.equal(hostKind({ entry: "cli", term: "vscode", bundle: "com.microsoft.VSCode" }), "vscode-terminal");
	assert.deepEqual(jumpPlan(sess("s", "/Users/me/code/app", { entry: "cli", term: "vscode", bundle: "com.microsoft.VSCode" }), "darwin"), [{ cmd: "open", args: ["-b", "com.microsoft.VSCode", "/Users/me/code/app"] }]);
	const iterm = jumpPlan(sess("s", "/x", { entry: "cli", term: "iTerm.app", itermSession: "w0t1p0:9F5C-AB12" }), "darwin")[0] as { cmd: string; args: string[] };
	assert.equal(iterm.cmd, "osascript");
	assert.equal(iterm.args.at(-1), "9F5C-AB12", "el id va como argumento, no dentro del script");
	const term = jumpPlan(sess("s", "/x", { entry: "cli", term: "Apple_Terminal", tty: "/dev/ttys003" }), "darwin")[0] as { cmd: string; args: string[] };
	assert.equal(term.args.at(-1), "/dev/ttys003");
	assert.equal(hostLabel({ entry: "cli", term: "ghostty", bundle: "com.mitchellh.ghostty" }), "ghostty");
	assert.deepEqual(jumpPlan(sess("s", "/x", { entry: "cli", term: "ghostty", bundle: "com.mitchellh.ghostty" }), "darwin"), [{ cmd: "open", args: ["-b", "com.mitchellh.ghostty"] }]);
	assert.deepEqual(jumpPlan(sess("s", "/x", { entry: "cli", bundle: "com.evil; rm -rf" }), "darwin"), [], "bundle raro: nada");
	assert.deepEqual(
		jumpPlan(sess("s", "/tmp/evil.command", { entry: "claude-vscode", bundle: "com.apple.Terminal" }), "darwin")[0],
		{ cmd: "open", args: ["-b", "com.microsoft.VSCode", "/tmp/evil.command"] },
		"con una ruta solo se abre un editor de la familia VS Code",
	);
	assert.deepEqual(jumpPlan(sess("s", "/x"), "darwin"), [], "sin origen: nada");
	console.log("   ✓ plan para ir a la sesión (app, VS Code, iTerm, Terminal, otras)");

	console.log("2. notificador .sh real");
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "claude-deck-"));
	const script = path.join(tmp, "claude-deck-notify.sh");
	await fs.writeFile(script, notifierScript(PORT), { mode: 0o755 });
	const r = await runNotifier(script, "needs_you", JSON.stringify({ session_id: "C", hook_event_name: "Notification", cwd: "/tmp/otro" }));
	assert.equal(r.stdout, "");
	assert.equal(r.code, 0);
	await new Promise((res) => setTimeout(res, 50));
	assert.equal(registry.get("C")?.state, "needs_you");
	console.log(`   ✓ curl → plugin en ${r.ms} ms, salida vacía, exit 0`);
	// origen de la sesión: viaja en la URL, sin caracteres que rompan la query
	await runNotifier(script, "", JSON.stringify({ session_id: "C", hook_event_name: "PreToolUse", tool_name: "Bash" }), {
		CLAUDE_CODE_ENTRYPOINT: "cli",
		TERM_PROGRAM: "iTerm.app",
		ITERM_SESSION_ID: "w0t1p0:9F5C-AB12&x=1",
		__CFBundleIdentifier: "com.googlecode.iterm2",
	});
	await new Promise((res) => setTimeout(res, 50));
	assert.deepEqual(registry.get("C")?.client, { entry: "cli", term: "iTerm.app", itermSession: "w0t1p0:9F5C-AB12x1", bundle: "com.googlecode.iterm2" });
	await runNotifier(script, "", JSON.stringify({ session_id: "C", hook_event_name: "PostToolUse", tool_name: "Bash" }));
	await new Promise((res) => setTimeout(res, 50));
	assert.equal(registry.get("C")?.client?.term, "iTerm.app", "un evento sin entorno no borra el origen");
	console.log("   ✓ el notificador manda dónde corre la sesión");
	// sin servidor escuchando tampoco falla ni tarda
	server.close();
	await new Promise((res) => setTimeout(res, 100));
	const r2 = await runNotifier(script, "", JSON.stringify({ session_id: "C", hook_event_name: "Stop" }));
	assert.equal(r2.code, 0);
	console.log(`   ✓ sin servidor: exit 0 en ${r2.ms} ms`);

	console.log("3. instalador en ~/.claude temporal");
	process.env.CLAUDE_CONFIG_DIR = tmp;
	await fs.writeFile(path.join(tmp, "settings.json"), JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mio" }] }] } }, null, 2));
	const r1 = await installHooks(PORT);
	assert.ok(r1.ok && r1.backupPath);
	let settings = JSON.parse(await fs.readFile(path.join(tmp, "settings.json"), "utf8"));
	assert.equal(settings.model, "opus", "conserva otras claves");
	assert.equal(settings.hooks.Stop[0].hooks[0].command, "echo mio", "conserva hooks ajenos");
	assert.equal(settings.hooks.Stop.length, 2);
	assert.equal(Object.keys(desiredHooks("x")).length, 11);
	for (const ev of Object.keys(desiredHooks("x"))) assert.ok(settings.hooks[ev], `falta ${ev}`);
	assert.ok(settings.hooks.Notification.some((g: { matcher: string }) => g.matcher.includes("permission_prompt")));
	assert.ok(settings.hooks.PreToolUse[0].hooks[0].async === true);
	assert.ok((await fs.stat(r1.scriptPath)).mode & 0o100, "script ejecutable");
	assert.equal((await hooksStatus()).installed, true);
	await installHooks(PORT); // idempotente
	settings = JSON.parse(await fs.readFile(path.join(tmp, "settings.json"), "utf8"));
	assert.equal(settings.hooks.Stop.length, 2, "no duplica");
	assert.equal(await syncNotifierPort(PORT), false, "mismo puerto: no reescribe");
	assert.equal(await syncNotifierPort(18001), true);
	assert.ok((await fs.readFile(r1.scriptPath, "utf8")).includes(":-18001}"), "puerto nuevo en el script");
	assert.ok((await fs.stat(r1.scriptPath)).mode & 0o100, "sigue ejecutable");
	await uninstallHooks();
	assert.equal(await syncNotifierPort(18002), false, "sin notificador no crea nada");
	await assert.rejects(fs.access(r1.scriptPath));
	settings = JSON.parse(await fs.readFile(path.join(tmp, "settings.json"), "utf8"));
	assert.equal(settings.hooks.Stop.length, 1);
	assert.equal(settings.hooks.PreToolUse, undefined);
	assert.equal((await hooksStatus()).installed, false);
	console.log("   ✓ instala, respalda, no duplica, desinstala limpio");

	console.log("4. render de caras");
	const out = path.join("test", "out");
	await fs.mkdir(out, { recursive: true });
	const now = Date.now();
	const mk = (over: Partial<Session>): Session => ({ id: "x", project: "web-app-frontend", cwd: "", state: "idle", detail: "", since: now - 222_000, lastEvent: now, slot: 1, turns: 1, ...over });
	const faces: Record<string, string> = {
		"s-idle": renderSession(mk({ state: "idle" }), 0),
		"s-working": renderSession(mk({ state: "working", detail: "Bash" }), 1),
		"s-needs": renderSession(mk({ state: "needs_you", detail: "Edit" }), 1),
		"s-done": renderSession(mk({ state: "done" }), 0),
		"s-error": renderSession(mk({ state: "error", detail: "fallo de API" }), 0),
		"s-needs-steady": renderSession(mk({ state: "needs_you", detail: "pregunta" }), 0, { steady: true }),
		"s-label": renderSession(mk({ state: "working", detail: "Edit" }), 1, { label: "API" }),
		"s-host": renderSession(mk({ state: "needs_you", detail: "pregunta", slot: 16, since: now - 3_900_000 }), 0, { host: "iTerm" }),
		"s-empty": renderEmptySlot(3),
		"s-elsewhere": renderEmptySlot(3, "en otra tecla"),
		"u-both": renderUsageBoth({ fiveHour: { utilization: 42, resetsAt: new Date(now + 2.3 * 3600e3).toISOString() }, sevenDay: { utilization: 83, resetsAt: new Date(now + 3.2 * 86400e3).toISOString() }, fetchedAt: now, raw: {} }, { amber: 50, red: 80 }),
		"u-ring5h": renderUsageRing({ utilization: 67, resetsAt: new Date(now + 95 * 60e3).toISOString() }, "5 h", { amber: 50, red: 80 }),
		"u-ring7d": renderUsageRing({ utilization: null, resetsAt: null }, "7 d", { amber: 50, red: 80 }),
		"u-login": renderUsageStatus("login"),
		"u-offline": renderUsageStatus("offline"),
	};
	const needs = mk({ state: "needs_you" });
	assert.notEqual(renderSession(needs, 0), renderSession(needs, 1), "parpadea");
	assert.equal(renderSession(needs, 0, { steady: true }), renderSession(needs, 1, { steady: true }), "fijo no parpadea");
	assert.ok(faces["s-label"].includes(">API<") && !faces["s-label"].includes("web-app-fro"), "nombre propio");
	assert.ok(renderSession(needs, 0, { label: "" }).includes(">web-app-fro…<"), "nombre vacío → carpeta");
	for (const [name, svg] of Object.entries(faces)) await fs.writeFile(path.join(out, `${name}.svg`), svg);
	console.log(`   ✓ ${Object.keys(faces).length} caras en ${out}/`);
	await fs.rm(tmp, { recursive: true, force: true });
	console.log("\nTODO OK");
}

main().catch((err) => {
	console.error("FALLO:", err);
	process.exit(1);
});
