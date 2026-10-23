import { parseScope } from "../../lib/scope.js";

// Multi-value scope input for node and relation forms: one toggle per allowed value, or a text field
// (comma-separated) when the schema does not list the values. An empty selection means unscoped.
export function ScopeField({ onChange, scopeValues = [], value = [] }) {
	const selected = parseScope(value);

	if (scopeValues.length === 0) {
		return (
			<input value={selected.join(", ")} onInput={(event) => onChange(parseScope(event.currentTarget.value))} placeholder="Empty: unscoped" />
		);
	}

	function toggle(scope) {
		if (selected.includes(scope)) {
			onChange(selected.filter((item) => item !== scope));
			return;
		}
		// "common" stands alone: choosing it clears the other values, and choosing another value clears it.
		onChange(scope === "common" ? ["common"] : parseScope([...selected.filter((item) => item !== "common"), scope]));
	}

	return (
		<div class="scope-field" role="group" aria-label="Scope">
			{scopeValues.map((scope) => (
				<button
					type="button"
					class={`scope-chip${selected.includes(scope) ? " active" : ""}`}
					aria-pressed={selected.includes(scope)}
					onClick={() => toggle(scope)}
					key={scope}
				>
					{scope}
				</button>
			))}
			{selected.length === 0 && <small class="scope-hint">Unscoped</small>}
		</div>
	);
}
