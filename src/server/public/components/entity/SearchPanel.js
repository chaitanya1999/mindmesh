import { useEffect, useRef, useState } from "preact/hooks";

export function SearchPanel({ clientResults, isSearching, onFocusNode, onQuery, onSearch, query, searchMessage, serverResults }) {
	const panelRef = useRef(null);
	const [isOpen, setIsOpen] = useState(false);
	const shownResults = serverResults.length > 0 ? serverResults : clientResults;
	const hasQuery = Boolean(query.trim());
	const hasResults = shownResults.length > 0;

	useEffect(() => {
		if (!hasQuery) {
			setIsOpen(false);
			return undefined;
		}

		function handlePointerDown(event) {
			if (!panelRef.current?.contains(event.target)) {
				setIsOpen(false);
			}
		}

		document.addEventListener("pointerdown", handlePointerDown, true);
		return () => document.removeEventListener("pointerdown", handlePointerDown, true);
	}, [hasQuery]);

	function handleSubmit(event) {
		event.preventDefault();
		setIsOpen(true);
		onSearch();
	}

	return (
		<form class="search-panel" onSubmit={handleSubmit} ref={panelRef}>
			<label class="sr-only" htmlFor="node-search">Search nodes</label>
			<input
				id="node-search"
				type="search"
				placeholder="Search loaded nodes, or press Enter for full search..."
				value={query}
				onFocus={() => {
					if (hasQuery) {
						setIsOpen(true);
					}
				}}
				onInput={(event) => {
					onQuery(event.currentTarget.value);
					setIsOpen(Boolean(event.currentTarget.value.trim()));
				}}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						setIsOpen(false);
					}
				}}
			/>
			<button type="submit" class="compact-button" disabled={isSearching}>
				{isSearching ? "Searching" : "Search"}
			</button>
			{searchMessage && (
				<div class="search-status" role="status">{searchMessage}</div>
			)}
			{isOpen && hasQuery && hasResults && (
				<div class="search-results">
					{shownResults.map((node) => (
						<button
							type="button"
							class="search-result"
							key={node.id}
							onClick={() => {
								setIsOpen(false);
								onFocusNode(node);
							}}
						>
							<span>{node.label}</span>
							<small>{node.type}</small>
						</button>
					))}
				</div>
			)}
		</form>
	);
}
