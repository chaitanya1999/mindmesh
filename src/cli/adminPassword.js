#!/usr/bin/env node
// Sets the admin panel password: stores only its scrypt hash in config.json (`admin.passwordHash`).
// Usage: npm run kg:admin:password            (asks twice, input hidden)
//        ... -- --stdin                        (reads the password from the first line of stdin)
//        ... -- --config <path>                (another config file, for tests)
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { hashPassword, MIN_PASSWORD_LENGTH } from "../admin/adminAuth.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function argValue(argv, name) {
	const index = argv.indexOf(name);
	return index === -1 ? null : argv[index + 1];
}

function readStdinLine() {
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin });
		rl.once("line", (line) => {
			// Resolve before close(): close() fires the "close" handler synchronously.
			resolve(line);
			rl.close();
		});
		rl.once("close", () => resolve(""));
	});
}

// Reads one line without echoing it (shows * per character).
function askHidden(question) {
	return new Promise((resolve, reject) => {
		const input = process.stdin;
		if (!input.isTTY) {
			reject(new Error("No terminal to type into; use --stdin."));
			return;
		}
		process.stdout.write(question);
		let value = "";
		input.setRawMode(true);
		input.resume();
		input.setEncoding("utf8");
		const onData = (chunk) => {
			for (const char of chunk) {
				if (char === "\r" || char === "\n") {
					input.setRawMode(false);
					input.pause();
					input.off("data", onData);
					process.stdout.write("\n");
					resolve(value);
					return;
				}
				if (char === "\u0003") {
					input.setRawMode(false);
					process.stdout.write("\n");
					process.exit(130);
				}
				if (char === "\u007f" || char === "\b") {
					if (value.length > 0) {
						value = value.slice(0, -1);
						process.stdout.write("\b \b");
					}
					continue;
				}
				value += char;
				process.stdout.write("*");
			}
		};
		input.on("data", onData);
	});
}

// Writes admin.passwordHash into the raw config file, keeping placeholders, indentation, and line endings.
function writePasswordHash(configPath, passwordHash) {
	const raw = fs.readFileSync(configPath, "utf8");
	const eol = raw.includes("\r\n") ? "\r\n" : "\n";
	const indent = /\n([ \t]+)"/.exec(raw)?.[1] ?? "\t";
	const config = JSON.parse(raw);
	config.admin = { ...(config.admin ?? {}), passwordHash };
	fs.writeFileSync(configPath, `${JSON.stringify(config, null, indent).replace(/\n/g, eol)}${eol}`, "utf8");
}

async function main() {
	const argv = process.argv.slice(2);
	const configPath = path.resolve(argValue(argv, "--config") ?? path.join(PROJECT_ROOT, "config.json"));
	if (!fs.existsSync(configPath)) {
		throw new Error(`Config file not found: ${configPath}. Copy config.example.json to config.json first.`);
	}

	let password;
	if (argv.includes("--stdin")) {
		// Only the line break is stripped: the login compares the password exactly, spaces included.
		password = (await readStdinLine()).replace(/\r$/, "");
	} else {
		password = await askHidden(`New admin password (at least ${MIN_PASSWORD_LENGTH} characters): `);
		const again = await askHidden("Repeat it: ");
		if (again !== password) {
			throw new Error("The passwords do not match; nothing was changed.");
		}
	}

	writePasswordHash(configPath, hashPassword(password));
	console.log(`Admin password set in ${configPath} (only its hash is stored). Restart the web server to use it.`);
}

main().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
