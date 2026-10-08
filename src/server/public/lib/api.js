
export async function requestJson(url, options = {}) {
	const isFormData = options.body instanceof FormData;
	const headers = {
		...(isFormData ? {} : { "content-type": "application/json" }),
		...(options.headers ?? {}),
	};
	const response = await fetch(url, {
		...options,
		headers,
	});
	const body = await response.json().catch(() => ({}));

	if (!response.ok) {
		const error = new Error(body.error || `Request failed with status ${response.status}.`);
		error.status = response.status;
		error.url = url;
		throw error;
	}

	return body;
}
