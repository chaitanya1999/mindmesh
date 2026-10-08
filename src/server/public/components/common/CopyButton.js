import { useCallback, useEffect, useRef, useState } from "preact/hooks";

export function hasCopyableLlmText(value) {
	const text = String(value ?? "").trim();
	return Boolean(text && !["thinking...", "thinking", "loading...", "loading"].includes(text.toLowerCase()));
}

async function copyTextToClipboard(value) {
	const text = String(value ?? "");
	if (!text.trim()) {
		return false;
	}

	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return true;
	}

	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.left = "-9999px";
	document.body.appendChild(textarea);
	textarea.select();
	const copied = document.execCommand("copy");
	document.body.removeChild(textarea);
	return copied;
}

function CopyIcon() {
	return (
		<svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
			<rect x="9" y="9" width="10" height="10" rx="2" />
			<path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
		</svg>
	);
}

export function CopyButton({ className = "", label = "Copy to clipboard", onStatus, text }) {
	const [copied, setCopied] = useState(false);
	const timeoutRef = useRef(null);
	const hasText = hasCopyableLlmText(text);

	useEffect(() => () => {
		if (timeoutRef.current) {
			window.clearTimeout(timeoutRef.current);
		}
	}, []);

	const handleCopy = useCallback(async () => {
		try {
			const didCopy = await copyTextToClipboard(text);
			if (!didCopy) {
				onStatus?.("Nothing to copy.");
				return;
			}

			setCopied(true);
			onStatus?.("Copied to clipboard.");
			if (timeoutRef.current) {
				window.clearTimeout(timeoutRef.current);
			}
			timeoutRef.current = window.setTimeout(() => setCopied(false), 1400);
		} catch (error) {
			onStatus?.(error.message || "Copy failed.");
		}
	}, [onStatus, text]);

	if (!hasText) {
		return null;
	}

	return (
		<button
			type="button"
			class={`copy-button${copied ? " copied" : ""}${className ? ` ${className}` : ""}`}
			onClick={handleCopy}
			title={copied ? "Copied" : label}
			aria-label={copied ? "Copied" : label}
		>
			<CopyIcon />
			<span class="sr-only">{copied ? "Copied" : label}</span>
		</button>
	);
}
