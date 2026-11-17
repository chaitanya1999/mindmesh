import { formatScope, parseScope } from "../../lib/scope.js";

// Multi-value scope input for node and relation forms: one row of toggles per scope dimension, or a text field
// ("bu:uc,nc;module:sbd") when the schema declares no dimensions. A dimension with nothing selected is not stated.
export function ScopeField({ dimensions = [], onChange, value = [] }) {
	const selected = parseScope(value);

	if (dimensions.length === 0) {
		return (
			<input value={formatScope(selected)} onChange={(event) => onChange(parseScope(event.currentTarget.value))} placeholder="Empty: unscoped" />
		);
	}

	function toggle(entry) {
		onChange(selected.includes(entry) ? selected.filter((item) => item !== entry) : parseScope([...selected, entry]));
	}

	return (
		<div class="scope-field" role="group" aria-label="Scope">
			{dimensions.map((dimension) => (
				<div class="scope-dimension" key={dimension.name}>
					<small class="scope-dimension-label">{dimension.label || dimension.name}</small>
					{dimension.allowedValues.map((item) => {
						const entry = `${dimension.name}:${item}`;
						return (
							<button
								type="button"
								class={`scope-chip${selected.includes(entry) ? " active" : ""}`}
								aria-pressed={selected.includes(entry)}
								onClick={() => toggle(entry)}
								key={entry}
							>
								{item}
							</button>
						);
					})}
					{!selected.some((entry) => entry.startsWith(`${dimension.name}:`)) && <small class="scope-hint">Not stated</small>}
				</div>
			))}
		</div>
	);
}
