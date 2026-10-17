import { exec } from "node:child_process";
import path from "node:path";
import url from "node:url";
import { defineConfig } from "rolldown";

const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "com.aldomacias.claude-deck";
const sdPluginFolder = `${sdPlugin}.sdPlugin`;

export default defineConfig({
	input: {
		plugin: "src/plugin.ts",
		"install-hooks": "src/cli/install-hooks.ts",
		probe: "src/cli/probe.ts",
	},
	output: {
		dir: `${sdPluginFolder}/bin`,
		entryFileNames: "[name].js",
		chunkFileNames: "chunk-[name].js",
		sourcemap: isWatching,
		sourcemapPathTransform: (relativeSourcePath, sourcemapPath) =>
			url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href,
		minify: !isWatching,
	},
	transform: { decorator: { legacy: true } },
	platform: "node",
	resolve: { conditionNames: ["node"] },
	plugins: [
		{
			name: "watch-externals",
			buildStart() {
				this.addWatchFile(`${sdPluginFolder}/manifest.json`);
			},
			buildEnd() {
				if (isWatching) {
					exec(`streamdeck restart ${sdPlugin}`, (error, stdout, stderr) => {
						if (stdout) console.log(stdout.trim());
						if (stderr) console.error(stderr.trim());
						if (error) console.error("No se pudo reiniciar Stream Deck:", error.message);
					});
				}
			},
		},
		{
			name: "emit-module-package-file",
			generateBundle() {
				this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
			},
		},
	],
});
