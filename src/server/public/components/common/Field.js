
export function Field({ label, children }) {
	return (
		<label class="field">
			<span>{label}</span>
			{children}
		</label>
	);
}
