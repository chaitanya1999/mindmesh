// What a reviewer should confirm before approving. Static on purpose: a short list to glance at, not a form.
const CHECKS = [
	"Names: business-unit concepts carry the unit prefix (uc_qde_screen); shared technical artefacts keep their exact API name.",
	"Scope: prefixed nodes have the matching scope; common is used only for things every unit shares.",
	"Scope changes: an existing node's scope is replaced only on purpose (the card says \"Scope unchanged\" when it is kept).",
	"Reuse: nothing from another unit was reused just because the label matches.",
	"Relations: endpoints are the intended nodes; relation scope stays empty unless the relation applies to some units only.",
	"Signals: every ambiguity or contradiction is resolved or acceptable.",
];

export function HitlReviewChecklist() {
	return (
		<details class="hitl-review-checklist">
			<summary>Review checklist</summary>
			<ul>
				{CHECKS.map((check) => <li key={check}>{check}</li>)}
			</ul>
		</details>
	);
}
