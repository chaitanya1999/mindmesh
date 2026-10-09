import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

import { HitlProposalSummary } from "./HitlProposalSummary.js";
import { CopyButton } from "../common/CopyButton.js";
import {
	HITL_CHIP_DENSITY_KEY,
	appendSchemaSuggestion,
	deleteCount,
	deleteSchemaSuggestion,
	formatHitlDate,
	hitlCountLabel,
	hitlShortRef,
	hitlSignalCounts,
	needsAttention,
	noteMatchesFilter,
	noteOperationCounts,
	parseHitlProposal,
	pipelineEditorText,
	sortHitlNotes,
	strongNoteChips,
	truncateText,
	updateSchemaSuggestion,
} from "../../lib/hitlProposal.js";

const FILTERS = [
	{ id: "all", label: "All" },
	{ id: "attention", label: "Needs attention" },
	{ id: "contradictions", label: "Contradictions" },
	{ id: "ambiguities", label: "Ambiguities" },
	{ id: "deletes", label: "Deletes" },
	{ id: "schema", label: "Schema" },
];

function readStoredDensity() {
	try {
		return window.localStorage.getItem(HITL_CHIP_DENSITY_KEY) === "strong" ? "strong" : "compact";
	} catch {
		return "compact";
	}
}

function writeStoredDensity(value) {
	try {
		window.localStorage.setItem(HITL_CHIP_DENSITY_KEY, value);
	} catch {
		// localStorage is optional for this preference.
	}
}

const OPERATION_CODES = [
	{ key: "create", code: "C" },
	{ key: "update", code: "U" },
	{ key: "delete", code: "D" },
];

function OperationBreakdown({ code, counts }) {
	const parts = OPERATION_CODES.filter(({ key }) => counts[key] > 0);
	return (
		<span class="count-group">
			{counts.total}{code}
			{parts.length > 0 && (
				<span class="count-ops">
					{" ("}
					{parts.map(({ key, code: operationCode }, index) => (
						<span class={`count-op ${key}`} key={key}>{index > 0 ? " " : ""}{counts[key]}{operationCode}</span>
					))}
					{")"}
				</span>
			)}
		</span>
	);
}

function SubmissionCounts({ note }) {
	const counts = useMemo(() => noteOperationCounts(note), [note]);
	if (!counts) {
		return <span class="submission-counts">{hitlCountLabel(note)}</span>;
	}

	return (
		<span
			class="submission-counts"
			title="N nodes, R relations, NT node type suggestions, RT relation type suggestions. C create, U update, D delete."
		>
			<OperationBreakdown code="N" counts={counts.nodes} />
			<OperationBreakdown code="R" counts={counts.relations} />
			{counts.nodeTypes > 0 && <span class="count-group">{counts.nodeTypes}NT</span>}
			{counts.relationTypes > 0 && <span class="count-group">{counts.relationTypes}RT</span>}
		</span>
	);
}

function HitlNoteChips({ density, note }) {
	const signals = hitlSignalCounts(note);
	const hasSignals = signals.ambiguityCount > 0 || signals.contradictionCount > 0;

	if (density === "compact") {
		return (
			<>
				<SubmissionCounts note={note} />
				{hasSignals && (
					<span class="submission-signals" aria-label="Review signals">
						{signals.contradictionCount > 0 && (
							<span class="review-signal-chip contradiction">
								{signals.contradictionCount} contradiction{signals.contradictionCount === 1 ? "" : "s"}
							</span>
						)}
						{signals.ambiguityCount > 0 && (
							<span class="review-signal-chip ambiguity">
								{signals.ambiguityCount} {signals.ambiguityCount === 1 ? "ambiguity" : "ambiguities"}
							</span>
						)}
					</span>
				)}
			</>
		);
	}

	return (
		<span class="strong-chip-list" aria-label="HITL counts">
			{strongNoteChips(note).map((chip) => (
				<span class={`strong-chip ${chip.kind}`} key={`${chip.kind}-${chip.label}`}>
					{chip.label} {chip.value}
				</span>
			))}
		</span>
	);
}

function ProposalStatus({ isValid, proposal }) {
	if (!proposal.lines.length) {
		return <span class="proposal-status warning">Empty proposal</span>;
	}
	if (!isValid) {
		return <span class="proposal-status error">{proposal.errors.length} parse issue{proposal.errors.length === 1 ? "" : "s"}</span>;
	}
	if (proposal.signals.length > 0) {
		return <span class="proposal-status warning">{proposal.signals.length} review signal{proposal.signals.length === 1 ? "" : "s"}</span>;
	}
	return <span class="proposal-status valid">Valid proposal</span>;
}

export function HitlReviewPanel({
	editedResponse,
	graph,
	isProposalDirty,
	onEditedResponseChange,
	onGraphRefresh,
	onProposalFocus,
	onChangeReviewerName,
	onCloseSelectedNote,
	onSelectNote,
	onStatus,
	previewMessage,
	requestJson,
	reviewerName,
	routeSwitcher,
	selectedNote,
}) {
	const [activeFilter, setActiveFilter] = useState("all");
	const [activeProposalRowKey, setActiveProposalRowKey] = useState("");
	const [chipDensity, setChipDensity] = useState(readStoredDensity);
	const [isActing, setIsActing] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [notes, setNotes] = useState([]);
	const [panelMessage, setPanelMessage] = useState("");
	const [isRegenerating, setIsRegenerating] = useState(false);
	const [reviewerNotesDraft, setReviewerNotesDraft] = useState("");
	const proposal = useMemo(() => parseHitlProposal(editedResponse), [editedResponse]);
	const savedReviewerNotes = selectedNote?.reviewerNotes ?? "";
	const reviewerNotesDirty = reviewerNotesDraft.trim() !== savedReviewerNotes.trim();
	const filteredNotes = useMemo(() => (
		sortHitlNotes(notes).filter((note) => noteMatchesFilter(note, activeFilter))
	), [activeFilter, notes]);
	const pendingNodeCount = notes.reduce((total, note) => total + (note.nodeCount ?? 0) + (note.nodeDeleteCount ?? 0), 0);
	const pendingRelationCount = notes.reduce((total, note) => total + (note.relationCount ?? 0) + (note.relationDeleteCount ?? 0), 0);
	const proposalIsValid = proposal.errors.length === 0 && proposal.lines.length > 0;

	const showPanelMessage = useCallback((message) => {
		setPanelMessage(message);
		onStatus?.(message);
	}, [onStatus]);

	const loadNotes = useCallback(async () => {
		setIsLoading(true);
		try {
			const result = await requestJson("/api/hitl/notes?limit=100");
			setNotes(result.notes ?? []);
			setPanelMessage("");
		} catch (error) {
			showPanelMessage(error.message);
		} finally {
			setIsLoading(false);
		}
	}, [requestJson, showPanelMessage]);

	useEffect(() => {
		loadNotes();
	}, [loadNotes]);

	useEffect(() => {
		setReviewerNotesDraft(selectedNote?.reviewerNotes ?? "");
	}, [selectedNote?.id, selectedNote?.reviewerNotes]);

	function changeChipDensity(value) {
		const nextDensity = value === "strong" ? "strong" : "compact";
		setChipDensity(nextDensity);
		writeStoredDensity(nextDensity);
	}

	const openNote = useCallback(async (noteId) => {
		setIsLoading(true);
		setActiveProposalRowKey("");
		try {
			const result = await requestJson(`/api/hitl/notes/${encodeURIComponent(noteId)}`);
			onSelectNote(result.note ?? null);
			onEditedResponseChange(pipelineEditorText(result.note?.llmResponse ?? ""));
			setPanelMessage("");
		} catch (error) {
			showPanelMessage(error.message);
		} finally {
			setIsLoading(false);
		}
	}, [onEditedResponseChange, onSelectNote, requestJson, showPanelMessage]);

	const refreshReview = useCallback(async () => {
		await loadNotes();
		await onGraphRefresh?.();
	}, [loadNotes, onGraphRefresh]);

	const approveSelectedNote = useCallback(async () => {
		const activeReviewerName = reviewerName.trim();
		if (!selectedNote || !activeReviewerName) {
			return;
		}

		setIsActing(true);
		try {
			await requestJson(`/api/hitl/notes/${encodeURIComponent(selectedNote.id)}/approve`, {
				method: "POST",
				body: JSON.stringify({
					llmResponse: editedResponse,
					reviewedBy: activeReviewerName,
				}),
			});
			onSelectNote(null);
			onEditedResponseChange("");
			setActiveProposalRowKey("");
			await refreshReview();
			showPanelMessage("Approved and applied to the graph.");
		} catch (error) {
			showPanelMessage(error.message);
		} finally {
			setIsActing(false);
		}
	}, [editedResponse, onEditedResponseChange, onSelectNote, refreshReview, requestJson, reviewerName, selectedNote, showPanelMessage]);

	const rejectSelectedNote = useCallback(async () => {
		if (!selectedNote || !window.confirm("Reject and permanently delete this HITL note?")) {
			return;
		}

		setIsActing(true);
		try {
			await requestJson(`/api/hitl/notes/${encodeURIComponent(selectedNote.id)}`, {
				method: "DELETE",
			});
			onSelectNote(null);
			onEditedResponseChange("");
			setActiveProposalRowKey("");
			await refreshReview();
			showPanelMessage("Rejected and deleted from HITL queue.");
		} catch (error) {
			showPanelMessage(error.message);
		} finally {
			setIsActing(false);
		}
	}, [onEditedResponseChange, onSelectNote, refreshReview, requestJson, selectedNote, showPanelMessage]);

	const saveReviewerNotes = useCallback(async () => {
		if (!selectedNote) {
			return;
		}

		setIsActing(true);
		try {
			const result = await requestJson(`/api/hitl/notes/${encodeURIComponent(selectedNote.id)}/reviewer-notes`, {
				method: "PUT",
				body: JSON.stringify({ reviewerNotes: reviewerNotesDraft }),
			});
			// Keep any unsaved proposal edits; only the note's saved fields change.
			onSelectNote({ ...result.note, llmResponse: selectedNote.llmResponse });
			await loadNotes();
			showPanelMessage("Reviewer notes saved.");
		} catch (error) {
			showPanelMessage(error.message);
		} finally {
			setIsActing(false);
		}
	}, [loadNotes, onSelectNote, requestJson, reviewerNotesDraft, selectedNote, showPanelMessage]);

	const regenerateSelectedNote = useCallback(async () => {
		const activeReviewerName = reviewerName.trim();
		if (!selectedNote || !activeReviewerName || !reviewerNotesDraft.trim()) {
			return;
		}
		if (!window.confirm("Regenerate replaces this proposal with a new LLM extraction guided by your reviewer notes. Continue?")) {
			return;
		}

		setIsActing(true);
		setIsRegenerating(true);
		showPanelMessage("Regenerating proposal with reviewer notes...");
		try {
			const result = await requestJson(`/api/hitl/notes/${encodeURIComponent(selectedNote.id)}/regenerate`, {
				method: "POST",
				body: JSON.stringify({
					reviewerNotes: reviewerNotesDraft,
					llmResponse: editedResponse,
					reviewedBy: activeReviewerName,
				}),
			});
			onSelectNote(result.note);
			onEditedResponseChange(pipelineEditorText(result.note?.llmResponse ?? ""));
			setActiveProposalRowKey("");
			await refreshReview();
			showPanelMessage("Proposal regenerated. Review the new version before approving.");
		} catch (error) {
			showPanelMessage(`Regeneration failed; the proposal was not changed. ${error.message}`);
		} finally {
			setIsRegenerating(false);
			setIsActing(false);
		}
	}, [editedResponse, onEditedResponseChange, onSelectNote, refreshReview, requestJson, reviewerName, reviewerNotesDraft, selectedNote, showPanelMessage]);

	function focusProposalRow(record) {
		setActiveProposalRowKey(record.key);
		onProposalFocus?.(record);
	}

	function backToList() {
		if (isProposalDirty && !window.confirm("Discard unsaved edits to this HITL proposal?")) {
			return;
		}

		onCloseSelectedNote?.();
		setActiveProposalRowKey("");
	}

	function createSchemaSuggestion(entity) {
		onEditedResponseChange(appendSchemaSuggestion(editedResponse, entity));
		showPanelMessage("Added schema suggestion to this HITL proposal.");
	}

	function editSchemaSuggestion(record, draft) {
		onEditedResponseChange(updateSchemaSuggestion(editedResponse, record, draft));
	}

	function removeSchemaSuggestion(record) {
		if (!window.confirm(`Delete schema suggestion "${record.name}" from this proposal?`)) {
			return;
		}

		onEditedResponseChange(deleteSchemaSuggestion(editedResponse, record));
		setActiveProposalRowKey("");
		showPanelMessage("Removed schema suggestion from this HITL proposal.");
	}

	return (
		<aside class="hitl-panel" aria-label="Human review workspace">
			<header class="hitl-header">
				<div>
					<p class="eyebrow">Human review</p>
					<h2>Pending approvals</h2>
				</div>
				<div class="hitl-header-actions">
					<button type="button" class="compact-button" onClick={refreshReview} disabled={isLoading || isActing}>Refresh</button>
					{routeSwitcher}
				</div>
			</header>
			<div class="hitl-identity">
				<div>
					<span>Reviewer</span>
					<strong>{reviewerName || "Name required"}</strong>
				</div>
				<button type="button" class="identity-change-button" onClick={onChangeReviewerName}>
					Change
				</button>
			</div>
			{(panelMessage || previewMessage) && <div class="status-line">{panelMessage || previewMessage}</div>}
			<div class="hitl-content">
				<div class="review-summary-grid">
					<div>{pendingNodeCount} pending nodes</div>
					<div>{pendingRelationCount} pending relations</div>
				</div>
				{!selectedNote ? (
					<section class="hitl-section">
						<div class="hitl-toolbar">
							<label class="field">
								<span>Filter</span>
								<select value={activeFilter} onChange={(event) => setActiveFilter(event.currentTarget.value)}>
									{FILTERS.map((filter) => <option value={filter.id} key={filter.id}>{filter.label}</option>)}
								</select>
							</label>
							<label class="field">
								<span>Chips</span>
								<select value={chipDensity} onChange={(event) => changeChipDensity(event.currentTarget.value)}>
									<option value="compact">Compact</option>
									<option value="strong">Strong</option>
								</select>
							</label>
						</div>
						<div class="hitl-section-header">
							<h3>Pending submissions</h3>
							<span>{isLoading ? "Loading" : filteredNotes.length}</span>
						</div>
						<div class="submission-list" role="list">
							{filteredNotes.map((note) => {
								const hasSignals = needsAttention(note);
								return (
									<button
										type="button"
										class={`submission-row${hasSignals ? " has-review-signals" : ""}`}
										key={note.id}
										onClick={() => openNote(note.id)}
									>
										<span class="submission-main">
											<strong>{note.ingestedBy || note.userName || "Unknown user"}</strong>
											<small>{truncateText(note.inputPreview, 72)}</small>
											<small>
												{formatHitlDate(note.createdAt)} · <code>{hitlShortRef(note.id)}</code>
												{note.regenerated && <span class="note-tag regenerated">Regenerated</span>}
												{note.reviewerNotes && <span class="note-tag notes" title={note.reviewerNotes}>Notes</span>}
											</small>
										</span>
										<span class={`status-chip ${note.status}`}>{note.status}</span>
										<HitlNoteChips density={chipDensity} note={note} />
									</button>
								);
							})}
							{!isLoading && filteredNotes.length === 0 && (
								<div class="empty-review-state">No pending HITL items for this filter.</div>
							)}
						</div>
					</section>
				) : (
					<section class="hitl-section submission-detail">
						<div class={`hitl-mode-banner draft${isProposalDirty ? " dirty" : ""}`}>
							<strong>Proposal draft mode</strong>
							<span>Graph and schema edits update this proposal only. They apply to the DB after approval.</span>
						</div>
						<div class="hitl-section-header">
							<button
								type="button"
								class="compact-button"
								onClick={backToList}
							>
								Back
							</button>
							<div class="hitl-detail-status">
								{isProposalDirty && <span class="proposal-status warning">Unsaved proposal edits</span>}
								<span class={`status-chip ${selectedNote.status}`}>{selectedNote.status}</span>
							</div>
						</div>
						<div class="detail-kv">
							<span>Ingested by</span>
							<strong>{selectedNote.ingestedBy || selectedNote.userName || "Unknown user"}</strong>
						</div>
						<div class="detail-kv">
							<span>Created</span>
							<strong>{formatHitlDate(selectedNote.createdAt)}</strong>
						</div>
						<div class="detail-kv">
							<span>Proposal ID</span>
							<span class="proposal-id">
								<code title={`Short reference for agent chat: ${hitlShortRef(selectedNote.id)}`}>{selectedNote.id}</code>
								<CopyButton label="Copy proposal ID" text={selectedNote.id} />
							</span>
						</div>
						{selectedNote.regenerated && (
							<div class="detail-kv">
								<span>Regenerated</span>
								<strong>
									{selectedNote.regeneratedBy || "Unknown"} · {formatHitlDate(selectedNote.regeneratedAt)}
									{selectedNote.regenerationOrigin === "agent" ? " · via agent" : ""}
								</strong>
							</div>
						)}
						<label class="field">
							<span>User input</span>
							<textarea readOnly rows="4" value={selectedNote.userInput || selectedNote.prompt || ""} />
						</label>
						<HitlProposalSummary
							activeRowKey={activeProposalRowKey}
							graph={graph}
							onCreateSchemaSuggestion={createSchemaSuggestion}
							onDeleteSchemaSuggestion={removeSchemaSuggestion}
							onRowFocus={focusProposalRow}
							onUpdateSchemaSuggestion={editSchemaSuggestion}
							proposal={proposal}
						/>
						<section class="reviewer-notes">
							<label class="field">
								<span>Reviewer notes</span>
								<textarea
									rows="4"
									value={reviewerNotesDraft}
									disabled={isRegenerating}
									placeholder="e.g. EKYC is a UI section shown on the Pre DA screen, not a separate screen. Reuse mobile_number__c instead of creating Mobile Number."
									onInput={(event) => setReviewerNotesDraft(event.currentTarget.value)}
								/>
							</label>
							<p class="reviewer-notes-hint">
								Instructions for the LLM. <strong>Regenerate</strong> re-runs extraction on the original input with
								these notes as top-priority corrections and replaces this proposal. Saved notes are also used when
								you ask your agent to regenerate proposal <code>{hitlShortRef(selectedNote.id)}</code>.
							</p>
							<div class="reviewer-notes-actions">
								{reviewerNotesDirty && <span class="proposal-status warning">Unsaved notes</span>}
								<button
									type="button"
									class="compact-button"
									disabled={isActing || !reviewerNotesDirty}
									onClick={saveReviewerNotes}
								>
									Save notes
								</button>
								<button
									type="button"
									class="primary compact-button"
									disabled={isActing || !reviewerName.trim() || !reviewerNotesDraft.trim()}
									title="Replaces the current proposal. Copy the raw response below first if you want a backup."
									onClick={regenerateSelectedNote}
								>
									{isRegenerating ? "Regenerating..." : "Regenerate"}
								</button>
							</div>
						</section>
						<details class="hitl-raw-response">
							<summary>Advanced raw response</summary>
							<label class="field">
								<span class="raw-response-label">
									Editable piped LLM response
									<CopyButton label="Copy raw response" text={editedResponse} />
								</span>
								<textarea
									class="pipeline-preview"
									rows="12"
									value={editedResponse}
									readOnly={isRegenerating}
									onInput={(event) => onEditedResponseChange(event.currentTarget.value)}
								/>
							</label>
						</details>
						<div class="hitl-decision-footer">
							<div class="proposal-footer-status">
								<ProposalStatus isValid={proposalIsValid} proposal={proposal} />
								{isProposalDirty && <span class="proposal-status warning">Unsaved edits</span>}
							</div>
							<div class="hitl-decision-actions">
								<button
									type="button"
									class="primary compact-button"
									disabled={isActing || !reviewerName.trim() || !editedResponse.trim()}
									onClick={approveSelectedNote}
								>
									Approve
								</button>
								<button
									type="button"
									class="danger-button compact-button"
									disabled={isActing}
									onClick={rejectSelectedNote}
								>
									Reject
								</button>
							</div>
						</div>
					</section>
				)}
			</div>
		</aside>
	);
}
