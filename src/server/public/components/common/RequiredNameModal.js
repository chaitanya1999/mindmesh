import { useState } from "preact/hooks";

export function RequiredNameModal({
	eyebrow = "Workspace access",
	fieldLabel = "Name",
	helperText = "Ask and Ingest unlock after this step. The name is kept only for this page session.",
	initialName = "",
	onSubmit,
	placeholder = "Enter your name to continue",
	title = "Enter your name",
}) {
	const [draftName, setDraftName] = useState(initialName);
	const cleanName = draftName.trim();

	function handleSubmit(event) {
		event.preventDefault();
		if (cleanName) {
			onSubmit(cleanName);
		}
	}

	return (
		<div class="modal-backdrop locked-modal-backdrop" role="presentation">
			<section
				class="modal-panel name-modal"
				role="dialog"
				aria-modal="true"
				aria-labelledby="name-modal-title"
			>
				<header class="modal-header">
					<div>
						<p class="eyebrow">{eyebrow}</p>
						<h3 id="name-modal-title">{title}</h3>
					</div>
				</header>
				<form class="edit-form" onSubmit={handleSubmit}>
					<label class="field">
						<span>{fieldLabel}</span>
						<input
							autoFocus
							type="text"
							placeholder={placeholder}
							value={draftName}
							onInput={(event) => setDraftName(event.currentTarget.value)}
						/>
					</label>
					<p class="muted-copy">{helperText}</p>
					<button type="submit" class="primary" disabled={!cleanName}>Continue</button>
				</form>
			</section>
		</div>
	);
}
