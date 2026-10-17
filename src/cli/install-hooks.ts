import { installHooks, uninstallHooks, hooksStatus } from "../hooks-install.js";
import { DEFAULT_PORT } from "../server.js";

const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith("--port="));
const port = portArg ? Number(portArg.split("=")[1]) || DEFAULT_PORT : DEFAULT_PORT;

async function main(): Promise<void> {
	if (args.includes("--status")) {
		const s = await hooksStatus();
		console.log(s.installed ? `OK — ${s.detail}` : `No instalado — ${s.detail}`);
		return;
	}
	const result = args.includes("--uninstall") ? await uninstallHooks() : await installHooks(port);
	console.log(result.message);
	if (result.backupPath) console.log(`Respaldo: ${result.backupPath}`);
	console.log(`Script: ${result.scriptPath}`);
}

main().catch((err) => {
	console.error((err as Error).message);
	process.exit(1);
});
