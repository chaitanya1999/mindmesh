
export function SchemaEntryList({ entries, onEntriesChange, title }) {
	function updateEntry(index, field, value) {
		onEntriesChange(entries.map((entry, entryIndex) => (
			entryIndex === index ? { ...entry, [field]: value } : entry
		)));
	}

	return (
		<section class="schema-section">
			<div class="hitl-section-header">
				<h3>{title}</h3>
				<span>{entries.length}</span>
			</div>
			<div class="schema-entry-list">
				{entries.map((entry, index) => (
					<div class="schema-entry-row" key={`${title}-${index}`}>
						<input
							aria-label={`${title} name`}
							value={entry.name ?? ""}
							placeholder="type_name"
							onInput={(event) => updateEntry(index, "name", event.currentTarget.value)}
						/>
						<textarea
							aria-label={`${title} description`}
							rows="2"
							value={entry.description ?? ""}
							placeholder="Description"
							onInput={(event) => updateEntry(index, "description", event.currentTarget.value)}
						/>
						<button
							type="button"
							class="danger-button"
							onClick={() => onEntriesChange(entries.filter((_, entryIndex) => entryIndex !== index))}
						>
							Delete
						</button>
					</div>
				))}
				<button
					type="button"
					class="compact-button schema-add-button"
					onClick={() => onEntriesChange([...entries, { name: "", description: "" }])}
				>
					Add {title.toLowerCase().replace(/s$/, "")}
				</button>
			</div>
		</section>
	);
}
