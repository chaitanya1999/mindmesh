import { useEffect } from "preact/hooks";

export function EntityModal({ children, onClose, title }) {
	useEffect(() => {
		function handleKeyDown(event) {
			if (event.key === "Escape") {
				onClose();
			}
		}

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onClose]);

	return (
		<div class="modal-backdrop" role="presentation" onMouseDown={onClose}>
			<section
				class="modal-panel"
				role="dialog"
				aria-modal="true"
				aria-labelledby="modal-title"
				onMouseDown={(event) => event.stopPropagation()}
			>
				<header class="modal-header">
					<h3 id="modal-title">{title}</h3>
					<button type="button" class="icon-button" aria-label="Close modal" onClick={onClose}>x</button>
				</header>
				{children}
			</section>
		</div>
	);
}
