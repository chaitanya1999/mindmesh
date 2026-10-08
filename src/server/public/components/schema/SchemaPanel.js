import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { RouteSwitcher } from "../common/RouteSwitcher.js";
import { SchemaEntryList } from "./SchemaEntryList.js";
import { SchemaPropertySummary } from "./SchemaPropertySummary.js";
import { requestJson } from "../../lib/api.js";
import { toSnakeCase } from "../../lib/utils.js";

function cloneJson(value) {
	return JSON.parse(JSON.stringify(value ?? {}));
}

function normalizeSchemaEntries(entries, { includeReason = false } = {}) {
	const merged = new Map();
	for (const entry of Array.isArray(entries) ? entries : []) {
		const name = toSnakeCase(entry?.name);
		if (!name) {
			continue;
		}

		const existing = merged.get(name);
		merged.set(name, {
			name,
			description: String(entry?.description ?? existing?.description ?? "").trim(),
			...(includeReason ? { reason: String(entry?.reason ?? existing?.reason ?? "").trim() } : {}),
		});
	}

	return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeSchemaDraft(schema) {
	const nextSchema = {
		...cloneJson(schema),
		nodeTypes: normalizeSchemaEntries(schema?.nodeTypes),
		relationshipTypes: normalizeSchemaEntries(schema?.relationshipTypes),
	};
	delete nextSchema.path;
	delete nextSchema.fallbacks;
	delete nextSchema.suggestions;
	return nextSchema;
}

function formatSchemaJson(schema) {
	return `${JSON.stringify(normalizeSchemaDraft(schema), null, "\t")}\n`;
}

function updateSchemaEntries(draft, key, updater) {
	return {
		...draft,
		[key]: updater(Array.isArray(draft?.[key]) ? draft[key] : []),
	};
}

export function SchemaPanel() {
	const [activeTab, setActiveTab] = useState("types");
	const [draft, setDraft] = useState(null);
	const [jsonDraft, setJsonDraft] = useState("");
	const [savedDraftJson, setSavedDraftJson] = useState("");
	const [schemaPath, setSchemaPath] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [message, setMessage] = useState("");
	const [errorMessage, setErrorMessage] = useState("");
	const draftJson = useMemo(() => (draft ? formatSchemaJson(draft) : ""), [draft]);
	const hasStructuredChanges = Boolean(draft && savedDraftJson && draftJson !== savedDraftJson);
	const hasUnappliedJson = activeTab === "json" && jsonDraft !== draftJson;

	const applyServerSchema = useCallback((result) => {
		const nextDraft = normalizeSchemaDraft(result.schema);
		const nextJson = result.formattedJson || result.rawJson || formatSchemaJson(nextDraft);
		setDraft(nextDraft);
		setJsonDraft(nextJson);
		setSavedDraftJson(formatSchemaJson(nextDraft));
		setSchemaPath(result.pathLabel || result.path || "");
	}, []);

	const loadSchema = useCallback(async () => {
		setIsLoading(true);
		setErrorMessage("");
		try {
			const result = await requestJson("/api/schema");
			applyServerSchema(result);
			setMessage("Schema loaded.");
		} catch (error) {
			setErrorMessage(error.message || "Schema load failed.");
		} finally {
			setIsLoading(false);
		}
	}, [applyServerSchema]);

	useEffect(() => {
		loadSchema();
	}, [loadSchema]);

	useEffect(() => {
		if (activeTab !== "json" && draft) {
			setJsonDraft(draftJson);
		}
	}, [activeTab, draft, draftJson]);

	function changeDraft(updater) {
		setDraft((currentDraft) => cloneJson(
			typeof updater === "function" ? updater(currentDraft) : updater,
		));
		setMessage("");
		setErrorMessage("");
	}

	function applyJsonDraft() {
		try {
			const parsed = JSON.parse(jsonDraft);
			const normalized = normalizeSchemaDraft(parsed);
			setDraft(normalized);
			setJsonDraft(formatSchemaJson(normalized));
			setMessage("JSON applied to draft.");
			setErrorMessage("");
		} catch (error) {
			setErrorMessage(error.message || "Invalid schema JSON.");
		}
	}

	async function saveSchema() {
		setIsSaving(true);
		setErrorMessage("");
		try {
			const body = activeTab === "json" && hasUnappliedJson
				? { rawJson: jsonDraft }
				: { schema: normalizeSchemaDraft(draft) };
			const result = await requestJson("/api/schema", {
				method: "PUT",
				body: JSON.stringify(body),
			});
			applyServerSchema(result);
			setMessage("Schema saved.");
		} catch (error) {
			setErrorMessage(error.message || "Schema save failed.");
		} finally {
			setIsSaving(false);
		}
	}

	if (isLoading && !draft) {
		return (
			<aside class="schema-panel" aria-label="Graph schema workspace">
				<header class="hitl-header">
					<div>
						<p class="eyebrow">Graph schema</p>
						<h2>Schema manager</h2>
					</div>
					<RouteSwitcher />
				</header>
				<div class="schema-content">
					<p class="muted-copy">Loading schema...</p>
				</div>
			</aside>
		);
	}

	const nodeTypes = draft?.nodeTypes ?? [];
	const relationshipTypes = draft?.relationshipTypes ?? [];

	return (
		<aside class="schema-panel" aria-label="Graph schema workspace">
			<header class="hitl-header">
				<div>
					<p class="eyebrow">Graph schema</p>
					<h2>Schema manager</h2>
				</div>
				<div class="hitl-header-actions">
					<RouteSwitcher />
				</div>
			</header>
			<div class="schema-meta">
				<span>File</span>
				<strong>{schemaPath || "graphSchema.json"}</strong>
			</div>
			{(message || errorMessage || hasStructuredChanges || hasUnappliedJson) && (
				<div class={`status-line${errorMessage ? " error-status" : ""}`}>
					{errorMessage || (hasUnappliedJson ? "JSON has unapplied edits." : hasStructuredChanges ? "Unsaved schema changes." : message)}
				</div>
			)}
			<div class="schema-tabs" role="tablist" aria-label="Schema views">
				{[
					{ id: "types", label: "Types" },
					{ id: "json", label: "JSON" },
				].map((tab) => (
					<button
						type="button"
						class={activeTab === tab.id ? "active" : ""}
						onClick={() => setActiveTab(tab.id)}
						key={tab.id}
					>
						{tab.label}
					</button>
				))}
			</div>
			<div class="schema-content">
				{activeTab === "types" && (
					<>
						<SchemaPropertySummary schema={draft} />
						<SchemaEntryList
							title="Node types"
							entries={nodeTypes}
							onEntriesChange={(entries) => changeDraft((currentDraft) => updateSchemaEntries(currentDraft, "nodeTypes", () => entries))}
						/>
						<SchemaEntryList
							title="Relationship types"
							entries={relationshipTypes}
							onEntriesChange={(entries) => changeDraft((currentDraft) => updateSchemaEntries(currentDraft, "relationshipTypes", () => entries))}
						/>
					</>
				)}
				{activeTab === "json" && (
					<section class="schema-section">
						<div class="hitl-section-header">
							<h3>Advanced JSON</h3>
							<span>{jsonDraft.length} chars</span>
						</div>
						<textarea
							class="schema-json-editor"
							value={jsonDraft}
							spellCheck={false}
							onInput={(event) => {
								setJsonDraft(event.currentTarget.value);
								setMessage("");
								setErrorMessage("");
							}}
						/>
						<div class="schema-json-actions">
							<button type="button" class="compact-button" onClick={() => setJsonDraft(formatSchemaJson(draft))}>Format</button>
							<button type="button" class="compact-button" onClick={applyJsonDraft}>Apply JSON</button>
						</div>
					</section>
				)}
			</div>
			<div class="schema-footer-actions">
				<button type="button" class="primary" onClick={saveSchema} disabled={isSaving || isLoading || !draft}>
					{isSaving ? "Saving..." : "Save schema"}
				</button>
				<button type="button" onClick={loadSchema} disabled={isSaving || isLoading}>
					Reset
				</button>
			</div>
		</aside>
	);
}
