
export function WorkspaceDivider({
	handleClick,
	maxWidth,
	minWidth,
	onCloseGraph,
	onCloseWorkspace,
	onDoubleClick,
	onKeyDown,
	onPointerDown,
	workspaceLabel = "Ask/Ingest",
	workspaceWidth,
}) {
	return (
		<div
			aria-label={`Resize ${workspaceLabel} panel`}
			aria-orientation="vertical"
			aria-valuemax={maxWidth}
			aria-valuemin={minWidth}
			aria-valuenow={Math.round(workspaceWidth)}
			class="workspace-resize-handle"
			onClick={handleClick}
			onDblClick={onDoubleClick}
			onKeyDown={onKeyDown}
			onPointerDown={onPointerDown}
			role="separator"
			tabIndex={0}
		>
			<div class="workspace-resize-actions">
				<button
					type="button"
					class="workspace-resize-action"
					aria-label="Close graph panel"
					title="Close graph panel"
					onClick={(event) => {
						event.stopPropagation();
						onCloseGraph();
					}}
					onDblClick={onDoubleClick}
					onPointerDown={(event) => event.stopPropagation()}
				>
					{"\u25C0"}
				</button>
				<button
					type="button"
					class="workspace-resize-action"
					aria-label={`Close ${workspaceLabel} panel`}
					title={`Close ${workspaceLabel} panel`}
					onClick={(event) => {
						event.stopPropagation();
						onCloseWorkspace();
					}}
					onDblClick={onDoubleClick}
					onPointerDown={(event) => event.stopPropagation()}
				>
					{"\u25B6"}
				</button>
			</div>
		</div>
	);
}
