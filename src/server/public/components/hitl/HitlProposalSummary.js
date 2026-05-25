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

function CurrentProposed({ current, proposed, type }) {
	if (!current) {
		return <div class="proposal-current muted-copy">Current context not loaded.</div>;
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

function ProposalSection({ actions, children, count, title }) {
	return (
		<section class="proposal-section">
			<div class="hitl-section-header">
				<h3>{title}</h3>
				<div class="proposal-section-actions">
					{actions}
					<span>{count}</span>
				</div>
			</div>
			{count === 0 ? (
				<p class="muted-copy">None.</p>
			) : (
				<div class="proposal-row-list">{children}</div>
			)}
		</section>
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
						onInput={(event) => updateField("name", event.currentTarget.value)}
					/>
				</label>
				<label class="compact-field">
					<span>Description</span>
					<input
						value={record.description}
						onInput={(event) => updateField("description", event.currentTarget.value)}
					/>
				</label>
				<label class="compact-field">
					<span>Reason</span>
					<input
						value={record.reason}
						onInput={(event) => updateField("reason", event.currentTarget.value)}
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
	if (!signals.length) {
		return (
			<section class="proposal-section">
				<div class="hitl-section-header">
					<h3>Review signals</h3>
					<span>0</span>
				</div>
				<p class="muted-copy">No ambiguity or contradiction metadata found.</p>
			</section>
		);
	}

	return (
		<section class="proposal-section">
			<div class="hitl-section-header">
				<h3>Review signals</h3>
				<span>{signals.length}</span>
			</div>
			<div class="proposal-row-list">
				{signals.map((signal, index) => (
					<div class="proposal-signal-row" key={`${signal.kind}-${index}`}>
						<span class={`review-signal-chip ${signal.kind}`}>{signal.kind}</span>
						<p>{signal.text}</p>
					</div>
				))}
			</div>
		</section>
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
	const deleteRows = [...(proposal.nodeDeletes ?? []), ...(proposal.relationDeletes ?? [])];
	const schemaRows = proposal.schemaSuggestions ?? [];
	const relationCurrent = (record) => findCurrentRelation(graph, record);
	const nodeCurrent = (record) => findCurrentNode(graph, record);

	return (
		<div class="proposal-summary">
			{proposal.errors?.length > 0 && (
				<section class="proposal-parse-errors">
					<strong>Parse issues</strong>
					{proposal.errors.map((error, index) => <p key={`${error}-${index}`}>{error}</p>)}
				</section>
			)}
			<ProposalSection title="Nodes" count={nodeRows.length}>
				{nodeRows.map((record) => {
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
							<small>{record.type}</small>
							{record.description && <small class="multiline-text">{displayPipelineText(record.description)}</small>}
							{record.metadata && <small class="proposal-row-warning multiline-text">{displayPipelineText(record.metadata)}</small>}
						</ProposalRow>
					);
				})}
			</ProposalSection>
			<ProposalSection title="Relations" count={relationRows.length}>
				{relationRows.map((record) => {
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
							<small class="multiline-text">{displayPipelineText(record.information || record.description) || "No extra detail."}</small>
							{record.metadata && <small class="proposal-row-warning multiline-text">{displayPipelineText(record.metadata)}</small>}
						</ProposalRow>
					);
				})}
			</ProposalSection>
			<ProposalSection title="Deletes" count={deleteRows.length}>
				{deleteRows.map((record) => {
					const isRelation = record.entity === "relationDelete";
					const current = isRelation ? relationCurrent(record) : nodeCurrent(record);
					return (
						<ProposalRow
							activeRowKey={activeRowKey}
							current={current}
							graphItem={current}
							key={record.key}
							onFocus={onRowFocus}
							record={record}
							type={isRelation ? "relation" : "node"}
						>
							<strong>{isRelation ? relationFact(record) : nodeLabel(record)}</strong>
							{record.metadata && <small class="proposal-row-warning multiline-text">{displayPipelineText(record.metadata)}</small>}
						</ProposalRow>
					);
				})}
			</ProposalSection>
			<ProposalSection
				title="Schema suggestions"
				count={schemaRows.length}
				actions={(
					<div class="schema-suggestion-actions">
						<button
							type="button"
							class="compact-button"
							onClick={() => onCreateSchemaSuggestion?.("nodeTypeSuggestion")}
						>
							Add node type
						</button>
						<button
							type="button"
							class="compact-button"
							onClick={() => onCreateSchemaSuggestion?.("relationTypeSuggestion")}
						>
							Add relation type
						</button>
					</div>
				)}
			>
				{schemaRows.map((record) => (
					<SchemaSuggestionRow
						activeRowKey={activeRowKey}
						key={record.key}
						onDelete={onDeleteSchemaSuggestion}
						onFocus={onRowFocus}
						onUpdate={onUpdateSchemaSuggestion}
						record={record}
					/>
				))}
			</ProposalSection>
			<ReviewSignalSummary signals={proposal.signals ?? []} />
		</div>
	);
}
