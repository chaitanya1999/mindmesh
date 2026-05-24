const AMBIGUITY_PATTERN = /\bAMBIGUITY\s*:/i;
const CONTRADICTION_PATTERN = /\bCONTRADICTION\s*:/i;

function hasSignal(value, pattern) {
	return pattern.test(String(value ?? ""));
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
