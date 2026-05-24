import fs from "node:fs/promises";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export function parseArgs(argv) {
	const options = {
		interactive: false,
		file: null,
		provider: null,
		textParts: [],
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];

		if (arg === "--interactive" || arg === "-i") {
			options.interactive = true;
		} else if (arg === "--file" || arg === "-f") {
			options.file = argv[index + 1];
			index += 1;
		} else if (arg === "--provider") {
			options.provider = argv[index + 1];
			index += 1;
		} else {
			options.textParts.push(arg);
		}
	}

	return options;
}

export async function readInput({ argv, fallback, prompt }) {
	const options = parseArgs(argv);

	if (options.file) {
		return {
			text: (await fs.readFile(options.file, "utf8")).trim(),
			options,
			source: `file:${options.file}`,
		};
	}

	if (options.textParts.length > 0) {
		return {
			text: options.textParts.join(" ").trim(),
			options,
			source: "cli",
		};
	}

	if (options.interactive) {
		const rl = readline.createInterface({ input, output });
		try {
			const text = await rl.question(prompt);
			return {
				text: text.trim(),
				options,
				source: "interactive",
			};
		} finally {
			rl.close();
		}
	}

	return {
		text: fallback,
		options,
		source: "fallback",
	};
}
