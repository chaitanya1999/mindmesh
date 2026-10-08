
export function SchemaPropertySummary({ schema }) {
	const nodeRequired = schema?.nodeProperties?.required ?? [];
	const nodeOptional = schema?.nodeProperties?.optional ?? [];
	const relationRequired = schema?.relationshipProperties?.required ?? [];
	const relationOptional = schema?.relationshipProperties?.optional ?? [];

	return (
		<section class="schema-property-summary" aria-label="Schema property summary">
			<div>
				<span>Version</span>
				<strong>{schema?.version ?? "n/a"}</strong>
			</div>
			<div>
				<span>Node properties</span>
				<strong>{[...nodeRequired, ...nodeOptional].join(", ") || "None"}</strong>
			</div>
			<div>
				<span>Relation properties</span>
				<strong>{[...relationRequired, ...relationOptional].join(", ") || "None"}</strong>
			</div>
		</section>
	);
}
