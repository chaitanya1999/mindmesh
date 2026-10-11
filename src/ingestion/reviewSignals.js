const AMBIGUITY_PATTERN = /\bAMBIGUITY\s*:/i;
const CONTRADICTION_PATTERN = /\bCONTRADICTION\s*:/i;

function hasSignal(value, pattern) {
	return pattern.test(String(value ?? ""));
}

// Why a payload cannot be applied in `auto` mode. Only clean creates and updates auto-apply: anything with a
// schema violation, an ambiguity or contradiction signal, or a delete goes to HITL review.
// Future: per-signal severity (HIGH/MEDIUM/LOW) could let LOW signals auto-apply.
export function reviewReasons(graphPayload = {}) {
	const reasons = [];
	const violationCount = graphPayload.schemaViolations?.length ?? 0;
	const { ambiguityCount, contradictionCount } = countReviewSignals(graphPayload);
	const nodeDeleteCount = graphPayload.nodeDeletes?.length ?? 0;
	const relationDeleteCount = graphPayload.relationDeletes?.length ?? 0;

	if (violationCount > 0) {
		reasons.push(`${violationCount} schema violation(s)`);
	}
	if (ambiguityCount > 0) {
		reasons.push(`${ambiguityCount} ambiguity signal(s)`);
	}
	if (contradictionCount > 0) {
		reasons.push(`${contradictionCount} contradiction signal(s)`);
	}
	if (nodeDeleteCount > 0) {
		reasons.push(`${nodeDeleteCount} node delete(s)`);
	}
	if (relationDeleteCount > 0) {
		reasons.push(`${relationDeleteCount} relation delete(s)`);
	}

	return reasons;
}

export function countReviewSignals(graphPayload = {}) {
	const records = [
		...(graphPayload.nodes ?? []),
		...(graphPayload.relations ?? []),
		...(graphPayload.nodeDeletes ?? []),
		...(graphPayload.relationDeletes ?? []),
	];

	return records.reduce((counts, record) => {
		const metadata = record?.metadata ?? "";
		return {
			ambiguityCount: counts.ambiguityCount + (hasSignal(metadata, AMBIGUITY_PATTERN) ? 1 : 0),
			contradictionCount: counts.contradictionCount + (hasSignal(metadata, CONTRADICTION_PATTERN) ? 1 : 0),
		};
	}, {
		ambiguityCount: 0,
		contradictionCount: 0,
	});
}
