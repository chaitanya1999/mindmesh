import { Composer } from "./Composer.js";
import { MessageList } from "./MessageList.js";
import { RouteSwitcher } from "../common/RouteSwitcher.js";

const INGEST_FILE_ACCEPT = ".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export function ChatPanel({
	activeTab,
	askMessages,
	askText,
	includeUnverifiedKnowledge,
	ingestFiles,
	ingestMessages,
	ingestText,
	inputRef,
	isBusy,
	onClearIngest,
	onIngestFileClear,
	onIngestFiles,
	onIngestText,
	onAsk,
	onAskText,
	onIncludeUnverifiedKnowledgeChange,
	onIngest,
	onTab,
	statusMessage,
	userName,
	onChangeUserName,
	workspaceLocked = false,
}) {
	return (
		<aside class="chat-panel" aria-label="Ask and ingest workspace">
			<div class="workspace-identity">
				<div class="workspace-identity-main">
					<span>Workspace user</span>
					<strong>{userName || "Name required"}</strong>
				</div>
				<button type="button" class="identity-change-button" onClick={onChangeUserName}>
					Change
				</button>
				<RouteSwitcher />
			</div>
			<div class="tabs" role="tablist" aria-label="Workspace views">
				{["ask", "ingest"].map((tab) => (
					<button
						type="button"
						class={activeTab === tab ? "active" : ""}
						onClick={() => onTab(tab)}
						key={tab}
					>
						{tab}
					</button>
				))}
			</div>
			{statusMessage && <div class="status-line">{statusMessage}</div>}
			{activeTab === "ask" && (
				<>
					<MessageList className="ask-messages" messages={askMessages} />
					<Composer
						actionLabel="Ask"
						autoGrow
						className="ask-composer"
						disabled={workspaceLocked}
						inputId="ask-input"
						inputRef={inputRef}
						isBusy={isBusy}
						onInput={onAskText}
						onSubmit={onAsk}
						placeholder="Ask a question about the graph..."
						value={askText}
					/>
					<label class="ask-unverified-option">
						<input
							type="checkbox"
							checked={includeUnverifiedKnowledge}
							disabled={isBusy || workspaceLocked}
							onChange={(event) => onIncludeUnverifiedKnowledgeChange(event.currentTarget.checked)}
						/>
						<span>Include unapproved HITL information?</span>
					</label>
				</>
			)}
			{activeTab === "ingest" && (
				<>
					<MessageList className="ingest-messages" messages={ingestMessages} />
					<Composer
						actionLabel="Ingest"
						autoGrow
						className="ingest-composer"
						clearAction={{ label: "Clear ingest chat", onClick: onClearIngest }}
						disabled={workspaceLocked}
						files={ingestFiles}
						fileAccept={INGEST_FILE_ACCEPT}
						inputId="ingest-input"
						inputRef={inputRef}
						isBusy={isBusy}
						onFileClear={onIngestFileClear}
						onFilesSelect={onIngestFiles}
						onInput={onIngestText}
						onSubmit={onIngest}
						placeholder="Paste source text to extract nodes and relationships..."
						value={ingestText}
					/>
				</>
			)}
		</aside>
	);
}
