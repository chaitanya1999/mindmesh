// One scope for the Ask and Ingest tabs. Ask: only knowledge in this scope, common, or unscoped.
// Ingest: the scope of the input (it filters the context and is named in the extraction prompt).
export function ScopePicker({ disabled = false, onChange, scopeValues = [], value = "" }) {
	return (
		<label class="scope-picker" title="Ask: limits answers to this scope, common, and unscoped knowledge. Ingest: the scope of the text.">
			<span>Scope</span>
			<select value={value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)}>
				<option value="">None</option>
				{scopeValues.map((scope) => (
					<option value={scope} key={scope}>{scope}</option>
				))}
			</select>
		</label>
	);
}
