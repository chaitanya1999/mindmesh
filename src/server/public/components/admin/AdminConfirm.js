import { useState } from "preact/hooks";
import { Field } from "../common/Field.js";

// Confirmation for a destructive admin action: the admin password again plus a typed word. The button stays
// disabled until the word matches exactly.
export function AdminConfirm({ word, actionLabel, description, onConfirm, busy = false }) {
	const [password, setPassword] = useState("");
	const [typed, setTyped] = useState("");
	const ready = Boolean(password) && typed === word && !busy;

	async function handleSubmit(event) {
		event.preventDefault();
		if (!ready) {
			return;
		}
		const done = await onConfirm({ password, confirm: typed });
		if (done !== false) {
			setPassword("");
			setTyped("");
		}
	}

	return (
		<form class="admin-confirm" onSubmit={handleSubmit}>
			{description && <p class="muted-copy">{description}</p>}
			<div class="admin-confirm-fields">
				<Field label="Admin password">
					<input type="password" autocomplete="current-password" value={password} onInput={(event) => setPassword(event.currentTarget.value)} />
				</Field>
				<Field label={`Type ${word} to confirm`}>
					<input value={typed} onInput={(event) => setTyped(event.currentTarget.value)} autocomplete="off" spellcheck={false} />
				</Field>
			</div>
			<button type="submit" class="danger-button" disabled={!ready}>
				{busy ? "Working..." : actionLabel}
			</button>
		</form>
	);
}
