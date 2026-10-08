import { useEffect, useState } from "preact/hooks";
import { Field } from "../common/Field.js";
import { toSnakeCase, displayText } from "../../lib/utils.js";

export function createRelationDraft(relation) {
	return {
		sourceId: relation?.sourceId ?? "",
		targetId: relation?.targetId ?? "",
		relation: relation?.relation ?? "relates_to",
		information: displayText(relation?.information),
		description: displayText(relation?.description),
	};
}

export function RelationForm({
	deleteLabel = "Delete",
	draft: controlledDraft,
	graph,
	relationshipTypes = [],
	onCancel,
	onDelete,
	onDraftChange,
	onSave,
	relation,
	saveLabel = "Save relation",
}) {
	const isControlled = Boolean(controlledDraft && onDraftChange);
	const [localDraft, setLocalDraft] = useState(() => createRelationDraft(relation));
	const draft = isControlled ? controlledDraft : localDraft;
	const setDraft = isControlled ? onDraftChange : setLocalDraft;

	useEffect(() => {
		if (!isControlled) {
			setLocalDraft(createRelationDraft(relation));
		}
	}, [isControlled, relation]);

	function updateField(field, value) {
		setDraft((current) => ({ ...current, [field]: value }));
	}

	function handleSubmit(event) {
		event.preventDefault();
		onSave({ ...draft, relation: toSnakeCase(draft.relation) || "relates_to" });
	}

	return (
		<form class="edit-form" onSubmit={handleSubmit}>
			<datalist id="node-id-options">
				{graph.nodes.map((node) => <option value={node.id} key={node.id}>{node.label}</option>)}
			</datalist>
			<Field label="Source node">
				<input list="node-id-options" value={draft.sourceId} onInput={(event) => updateField("sourceId", event.currentTarget.value)} required />
			</Field>
			<Field label="Target node">
				<input list="node-id-options" value={draft.targetId} onInput={(event) => updateField("targetId", event.currentTarget.value)} required />
			</Field>
			<Field label="Relation">
				<datalist id="relation-type-options">
					{relationshipTypes.map((type) => (
						<option value={type} key={type}>
							{type}
						</option>
					))}
				</datalist>
				<input list="relation-type-options" value={draft.relation} onInput={(event) => updateField("relation", event.currentTarget.value)} required />
			</Field>
			<Field label="Information">
				<textarea rows="3" value={draft.information} onInput={(event) => updateField("information", event.currentTarget.value)} />
			</Field>
			<Field label="Description">
				<textarea rows="4" value={draft.description} onInput={(event) => updateField("description", event.currentTarget.value)} />
			</Field>
			<div class="form-actions">
				<button type="submit" class="primary">{saveLabel}</button>
				{onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
				{onDelete && <button type="button" class="danger-button" onClick={onDelete}>{deleteLabel}</button>}
			</div>
		</form>
	);
}
