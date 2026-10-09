import { useEffect, useState } from "preact/hooks";
import { Field } from "../common/Field.js";
import { toSnakeCase, displayText } from "../../lib/utils.js";

export function createNodeDraft(node) {
	return {
		label: node?.label ?? "",
		name: node?.name ?? "",
		type: node?.type ?? "concept",
		description: displayText(node?.description),
	};
}

export function NodeForm({
	deleteLabel = "Delete",
	draft: controlledDraft,
	node,
	nodeTypes = [],
	onCancel,
	onDelete,
	onDraftChange,
	onSave,
	saveLabel = "Save node",
}) {
	const isControlled = Boolean(controlledDraft && onDraftChange);
	// The id is node:<name>, so nodes already in the graph keep their name. Pending items without an
	// approved DB version (new in a proposal) can still be renamed.
	const isNameLocked = Boolean(node?.id) && (!node.pendingHitl || Boolean(node.approved));
	const [localDraft, setLocalDraft] = useState(() => createNodeDraft(node));
	const draft = isControlled ? controlledDraft : localDraft;
	const setDraft = isControlled ? onDraftChange : setLocalDraft;

	useEffect(() => {
		if (!isControlled) {
			setLocalDraft(createNodeDraft(node));
		}
	}, [isControlled, node]);

	function updateField(field, value) {
		setDraft((current) => ({ ...current, [field]: value }));
	}

	function handleSubmit(event) {
		event.preventDefault();
		onSave({ ...draft, name: isNameLocked ? node.name : draft.name || toSnakeCase(draft.label) });
	}

	return (
		<form class="edit-form" onSubmit={handleSubmit}>
			<Field label="Label">
				<input value={draft.label} onInput={(event) => updateField("label", event.currentTarget.value)} required />
			</Field>
			<Field label="Name">
				<input
					value={draft.name}
					onInput={(event) => updateField("name", event.currentTarget.value)}
					placeholder="auto_from_label"
					readOnly={isNameLocked}
					title={isNameLocked ? "The name is this node's permanent id. Change the label instead." : undefined}
				/>
			</Field>
			<Field label="Type">
				<datalist id="node-type-options">
					{nodeTypes.map((type) => (
						<option value={type} key={type}>
							{type}
						</option>
					))}
				</datalist>
				<input list="node-type-options" value={draft.type} onInput={(event) => updateField("type", event.currentTarget.value)} required />
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
