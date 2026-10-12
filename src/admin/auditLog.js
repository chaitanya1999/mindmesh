import fs from "node:fs";
import path from "node:path";

// Append-only JSON-lines log of admin actions (who, what, from where, outcome). Never contains passwords.
export class AdminAuditLog {
	constructor(filePath) {
		this.filePath = filePath;
	}

	write(entry) {
		fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
		fs.appendFileSync(this.filePath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
	}

	// Newest first.
	readRecent(limit = 100) {
		if (!fs.existsSync(this.filePath)) {
			return [];
		}
		return fs.readFileSync(this.filePath, "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.slice(-limit)
			.reverse()
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return { at: "", action: "unreadable", details: line };
				}
			});
	}
}
