import { scopeDimensionValue, withScopeDimension } from "../../lib/scope.js";

// One scope for the Ask and Ingest tabs, one select per scope dimension; `value` is the record form
// ("bu:uc;module:sbd"). Ask: per chosen dimension, only knowledge stating that value or none. Ingest: the scope
// of the text (it frames the extraction; the context is not filtered).
export function ScopePicker({ dimensions = [], disabled = false, onChange, value = "" }) {
	const title = "Ask: per dimension, limits answers to knowledge in that scope or not scoped in it. Ingest: the scope of the text.";

	if (dimensions.length === 0) {
		return (
			<label class="scope-picker" title={title}>
				<span>Scope</span>
				<input value={value} disabled={disabled} placeholder="bu:uc;module:sbd" onChange={(event) => onChange(event.currentTarget.value)} />
			</label>
		);
	}

	return (
		<div class="scope-picker" title={title}>
			{dimensions.map((dimension) => (
				<label key={dimension.name}>
					<span>{dimension.label || dimension.name}</span>
					<select
						value={scopeDimensionValue(value, dimension.name)}
						disabled={disabled}
						onChange={(event) => onChange(withScopeDimension(value, dimension.name, event.currentTarget.value))}
					>
						<option value="">None</option>
						{dimension.allowedValues.map((item) => (
							<option value={item} key={item}>{item}</option>
						))}
					</select>
				</label>
			))}
		</div>
	);
}
