import {
	displayPipelineText,
	displayNameFromIdentifier,
	relationLabel,
} from "../../lib/hitlProposal.js";

function operationLabel(operation) {
	if (operation === "delete") {
		return "Delete";
	}
	if (operation === "update") {
		return "Update";
	}
	if (operation === "suggest") {
		return "Suggest";
	}
	return "Create";
}

function operationClass(operation) {
	return `proposal-operation ${operation || "create"}`;
}

function nodeLabel(record) {
	return record.label || displayNameFromIdentifier(record.name || record.id);
}

function relationFact(record) {
	return `${displayNameFromIdentifier(record.sourceName)} ${relationLabel(record.relation)} ${displayNameFromIdentifier(record.targetName)}`;
}

function findCurrentNode(graph, record) {
	return graph?.nodes?.find((node) => node.id === record.id) ?? null;
}

function findCurrentRelation(graph, record) {
	return graph?.relations?.find((relation) => (
		relation.sourceId === record.sourceId
		&& relation.targetId === record.targetId
		&& relation.relation === record.relation
	)) ?? null;
}

function ReviewSignals({ signals }) {
	if (!signals?.length) {
		return null;
	}

	return (
		<span class="proposal-row-signals">
			{signals.map((signal, index) => (
				<span class={`review-signal-chip ${signal.kind}`} key={`${signal.kind}-${index}`}>
					{signal.kind}
				</span>
			))}
		</span>
	);
}

function CurrentProposed({ current: previewItem, proposed, type }) {
	if (!previewItem) {
		return <div class="proposal-current muted-copy">Current context not loaded.</div>;
	}

	// Preview items carry the proposal merged over the DB version; compare against the approved snapshot.
	const current = previewItem.pendingHitl ? previewItem.approved : previewItem;
	if (!current) {
		return <div class="proposal-current muted-copy">Not in the approved graph yet.</div>;
	}

	if (type === "relation") {
		return (
			<div class="proposal-current-grid">
				<div>
					<span>Current</span>
					<strong>{relationLabel(current.relation)}</strong>
					<small class="multiline-text">{displayPipelineText(current.information || current.description) || "No extra detail."}</small>
				</div>
				<div>
					<span>Proposed</span>
					<strong>{relationLabel(proposed.relation)}</strong>
					<small class="multiline-text">{displayPipelineText(proposed.information || proposed.description || proposed.metadata) || "No extra detail."}</small>
				</div>
			</div>
		);
	}

	return (
		<div class="proposal-current-grid">
			<div>
				<span>Current</span>
				<strong>{current.label || displayNameFromIdentifier(current.name || current.id)}</strong>
				<small class="multiline-text">{displayPipelineText(current.description) || "No description."}</small>
			</div>
			<div>
				<span>Proposed</span>
				<strong>{nodeLabel(proposed)}</strong>
				<small class="multiline-text">{displayPipelineText(proposed.description || proposed.metadata) || "No description."}</small>
			</div>
		</div>
	);
}

function ProposalRow({ activeRowKey, children, current, graphItem, onFocus, record, type }) {
	const isActive = activeRowKey === record.key;
	return (
		<button
			type="button"
			class={`proposal-row${isActive ? " active" : ""}`}
			onClick={() => onFocus?.(record)}
		>
			<span class={operationClass(record.operation)}>{operationLabel(record.operation)}</span>
			<span class="proposal-row-main">
				{children}
				{(record.operation === "update" || record.operation === "delete") && (
					<CurrentProposed current={current} proposed={record} type={type} />
				)}
			</span>
			<ReviewSignals signals={record.signals} />
			{!graphItem && (type === "node" || type === "relation") && (
				<small class="proposal-row-context">Not in preview</small>
			)}
		</button>
	);
}

// Collapsible group; non-empty groups start open. Leaf groups wrap rows, parent groups wrap other groups.
function ProposalGroup({ actions, children, count, isLeaf = true, level = 1, title, tone = "" }) {
	return (
		<details class={`proposal-group level-${level}${tone ? ` tone-${tone}` : ""}${count === 0 ? " empty" : ""}`} open={count > 0}>
			<summary>
				<span class="proposal-group-title">{title}</span>
				<span class="proposal-group-count">{count}</span>
			</summary>
			<div class="proposal-group-body">
				{actions && <div class="schema-suggestion-actions">{actions}</div>}
				{!isLeaf ? children : count === 0 ? (
					<p class="muted-copy">None.</p>
				) : (
					<div class="proposal-row-list">{children}</div>
				)}
			</div>
		</details>
	);
}

function SchemaSuggestionRow({ activeRowKey, onDelete, onFocus, onUpdate, record }) {
	function updateField(field, value) {
		onUpdate?.(record, { ...record, [field]: value });
	}

	return (
		<div
			class={`proposal-row schema-suggestion${activeRowKey === record.key ? " active" : ""}`}
			onClick={() => onFocus?.(record)}
		>
			<span class={operationClass("suggest")}>Suggest</span>
			<span class="proposal-row-main">
				<small>{record.entity === "nodeTypeSuggestion" ? "Node type" : "Relationship type"}</small>
				<label class="compact-field">
					<span>Name</span>
					<input
						value={record.name}
						onBlur={(event) => updateField("name", event.currentTarget.value)}
					/>
				</label>
				<label class="compact-field">
					<span>Description</span>
					<input
						value={record.description}
						onBlur={(event) => updateField("description", event.currentTarget.value)}
					/>
				</label>
				<label class="compact-field">
					<span>Reason</span>
					<input
						value={record.reason}
						onBlur={(event) => updateField("reason", event.currentTarget.value)}
					/>
				</label>
				<button
					type="button"
					class="danger-button compact-button"
					onClick={(event) => {
						event.stopPropagation();
						onDelete?.(record);
					}}
				>
					Delete suggestion
				</button>
			</span>
		</div>
	);
}

function ReviewSignalSummary({ signals }) {
	return (
		<ProposalGroup title="Review signals" count={signals.length}>
			{signals.map((signal, index) => (
				<div class="proposal-signal-row" key={`${signal.kind}-${index}`}>
					<span class={`review-signal-chip ${signal.kind}`}>{signal.kind}</span>
					<p>{signal.text}</p>
				</div>
			))}
		</ProposalGroup>
	);
}

export function HitlProposalSummary({
	activeRowKey,
	graph,
	onCreateSchemaSuggestion,
	onDeleteSchemaSuggestion,
	onRowFocus,
	onUpdateSchemaSuggestion,
	proposal,
}) {
	const nodeRows = proposal.nodes ?? [];
	const relationRows = proposal.relations ?? [];
	const nodeDeleteRows = proposal.nodeDeletes ?? [];
	const relationDeleteRows = proposal.relationDeletes ?? [];
	const schemaRows = proposal.schemaSuggestions ?? [];
	const nodeTypeRows = schemaRows.filter((record) => record.entity === "nodeTypeSuggestion");
	const relationTypeRows = schemaRows.filter((record) => record.entity === "relationTypeSuggestion");
	const nodeGroups = [
		{ title: "Create", tone: "create", rows: nodeRows.filter((record) => record.operation === "create") },
		{ title: "Update", tone: "update", rows: nodeRows.filter((record) => record.operation === "update") },
		{ title: "Delete", tone: "delete", rows: nodeDeleteRows },
	];
	const relationGroups = [
		{ title: "Create", tone: "create", rows: relationRows.filter((record) => record.operation === "create") },
		{ title: "Update", tone: "update", rows: relationRows.filter((record) => record.operation === "update") },
		{ title: "Delete", tone: "delete", rows: relationDeleteRows },
	];
	const relationCurrent = (record) => findCurrentRelation(graph, record);
	const nodeCurrent = (record) => findCurrentNode(graph, record);

	function renderNodeRow(record) {
		const current = nodeCurrent(record);
		return (
			<ProposalRow
				activeRowKey={activeRowKey}
				current={current}
				graphItem={current}
				key={record.key}
				onFocus={onRowFocus}
				record={record}
				type="node"
			>
				<strong>{nodeLabel(record)}</strong>
				{record.type && <small>{record.type}</small>}
				{record.description && <small class="multiline-text">{displayPipelineText(record.description)}</small>}
				{record.metadata && <small class="proposal-row-warning multiline-text">{displayPipelineText(record.metadata)}</small>}
			</ProposalRow>
		);
	}

	function renderRelationRow(record) {
		const current = relationCurrent(record);
		return (
			<ProposalRow
				activeRowKey={activeRowKey}
				current={current}
				graphItem={current}
				key={record.key}
				onFocus={onRowFocus}
				record={record}
				type="relation"
			>
				<strong>{relationFact(record)}</strong>
				{record.operation !== "delete" && (
					<small class="multiline-text">{displayPipelineText(record.information || record.description) || "No extra detail."}</small>
				)}
				{record.metadata && <small class="proposal-row-warning multiline-text">{displayPipelineText(record.metadata)}</small>}
			</ProposalRow>
		);
	}

	function renderSchemaRow(record) {
		return (
			<SchemaSuggestionRow
				activeRowKey={activeRowKey}
				key={record.key}
				onDelete={onDeleteSchemaSuggestion}
				onFocus={onRowFocus}
				onUpdate={onUpdateSchemaSuggestion}
				record={record}
			/>
		);
	}

	return (
		<div class="proposal-summary">
			{proposal.errors?.length > 0 && (
				<section class="proposal-parse-errors">
					<strong>Parse issues</strong>
					{proposal.errors.map((error, index) => <p key={`${error}-${index}`}>{error}</p>)}
				</section>
			)}
			<ProposalGroup title="Nodes" count={nodeRows.length + nodeDeleteRows.length} isLeaf={false}>
				{nodeGroups.map((group) => (
					<ProposalGroup key={group.title} level={2} title={group.title} tone={group.tone} count={group.rows.length}>
						{group.rows.map(renderNodeRow)}
					</ProposalGroup>
				))}
			</ProposalGroup>
			<ProposalGroup title="Relations" count={relationRows.length + relationDeleteRows.length} isLeaf={false}>
				{relationGroups.map((group) => (
					<ProposalGroup key={group.title} level={2} title={group.title} tone={group.tone} count={group.rows.length}>
						{group.rows.map(renderRelationRow)}
					</ProposalGroup>
				))}
			</ProposalGroup>
			<ProposalGroup title="Schema suggestions" count={schemaRows.length} isLeaf={false}>
				<ProposalGroup
					level={2}
					title="Node types"
					tone="suggest"
					count={nodeTypeRows.length}
					actions={(
						<button type="button" class="compact-button" onClick={() => onCreateSchemaSuggestion?.("nodeTypeSuggestion")}>
							Add node type
						</button>
					)}
				>
					{nodeTypeRows.map(renderSchemaRow)}
				</ProposalGroup>
				<ProposalGroup
					level={2}
					title="Relation types"
					tone="suggest"
					count={relationTypeRows.length}
					actions={(
						<button type="button" class="compact-button" onClick={() => onCreateSchemaSuggestion?.("relationTypeSuggestion")}>
							Add relation type
						</button>
					)}
				>
					{relationTypeRows.map(renderSchemaRow)}
				</ProposalGroup>
			</ProposalGroup>
			<ReviewSignalSummary signals={proposal.signals ?? []} />
		</div>
	);
}
