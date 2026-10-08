import { useEffect, useRef, useState } from "preact/hooks";
import { PaperclipIcon, TrashIcon } from "../common/Icons.js";

function formatFileSize(bytes) {
	const size = Number(bytes) || 0;

	if (size < 1024) {
		return `${size} B`;
	}

	if (size < 1024 * 1024) {
		return `${(size / 1024).toFixed(1)} KB`;
	}

	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function fileKey(file) {
	return `${file?.name ?? ""}:${file?.size ?? 0}:${file?.lastModified ?? 0}`;
}

export function Composer({
	actionLabel,
	autoGrow = false,
	className = "",
	clearAction = null,
	files = [],
	fileAccept,
	inputId,
	inputRef,
	disabled = false,
	isBusy,
	onFileClear,
	onFilesSelect,
	onInput,
	onSubmit,
	placeholder,
	value,
}) {
	const [isDragActive, setIsDragActive] = useState(false);
	const dragDepthRef = useRef(0);
	const fileInputRef = useRef(null);
	const textareaRef = useRef(null);
	const canAttachFile = Boolean(onFilesSelect);
	const hasFiles = files.length > 0;
	const isDisabled = isBusy || disabled;

	function resizeTextarea(element = textareaRef.current) {
		if (!autoGrow || !element) {
			return;
		}

		const maxHeight = 180;
		const minHeight = 42;
		element.style.height = "auto";
		const nextHeight = Math.max(minHeight, Math.min(element.scrollHeight, maxHeight));
		element.style.height = `${nextHeight}px`;
		element.style.overflowY = element.scrollHeight > maxHeight ? "auto" : "hidden";
	}

	function setTextareaRef(element) {
		textareaRef.current = element;

		if (typeof inputRef === "function") {
			inputRef(element);
		} else if (inputRef) {
			inputRef.current = element;
		}

		resizeTextarea(element);
	}

	useEffect(() => {
		resizeTextarea();
	}, [autoGrow, files.length, value]);

	function handleSubmit(event) {
		event.preventDefault();
		if (isDisabled) {
			return;
		}
		onSubmit();
	}

	function handleKeyDown(event) {
		if (!isDisabled && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			onSubmit();
		}
	}

	function handleTextareaInput(event) {
		if (isDisabled) {
			return;
		}
		resizeTextarea(event.currentTarget);
		onInput(event.currentTarget.value);
	}

	function hasDraggedFiles(event) {
		return Array.from(event.dataTransfer?.types ?? []).includes("Files");
	}

	function handleDragEnter(event) {
		if (!canAttachFile || isDisabled || !hasDraggedFiles(event)) {
			return;
		}

		event.preventDefault();
		dragDepthRef.current += 1;
		setIsDragActive(true);
	}

	function handleDragOver(event) {
		if (!canAttachFile || isDisabled || !hasDraggedFiles(event)) {
			return;
		}

		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
		setIsDragActive(true);
	}

	function handleDragLeave(event) {
		if (!canAttachFile) {
			return;
		}

		event.preventDefault();
		dragDepthRef.current = Math.max(dragDepthRef.current - 1, 0);
		if (dragDepthRef.current === 0) {
			setIsDragActive(false);
		}
	}

	function handleDrop(event) {
		if (!canAttachFile || isDisabled) {
			return;
		}

		event.preventDefault();
		dragDepthRef.current = 0;
		setIsDragActive(false);
		const nextFiles = Array.from(event.dataTransfer?.files ?? []);
		if (nextFiles.length > 0) {
			onFilesSelect(nextFiles);
		}
	}

	function handleFileInput(event) {
		const nextFiles = Array.from(event.currentTarget.files ?? []);
		if (nextFiles.length > 0) {
			onFilesSelect(nextFiles);
		}
		event.currentTarget.value = "";
	}

	return (
		<form class={`composer${className ? ` ${className}` : ""}`} onSubmit={handleSubmit}>
			<label class="sr-only" htmlFor={inputId}>Text input</label>
			<div
				class={`composer-input-shell${isDragActive ? " drag-active" : ""}${hasFiles ? " has-file" : ""}`}
				onDragEnter={handleDragEnter}
				onDragLeave={handleDragLeave}
				onDragOver={handleDragOver}
				onDrop={handleDrop}
			>
				{hasFiles && (
					<div class="file-list">
						{files.map((file) => (
							<div class="file-pill" key={fileKey(file)}>
								<span>{file.name}</span>
								<small>{formatFileSize(file.size)}</small>
								<button
									aria-label={`Remove ${file.name}`}
									class="file-remove"
									disabled={isDisabled}
									onClick={() => onFileClear(file)}
									type="button"
								>
									x
								</button>
							</div>
						))}
					</div>
				)}
			<textarea
				id={inputId}
				rows={autoGrow ? "1" : "5"}
				placeholder={placeholder}
				disabled={isDisabled}
				onInput={handleTextareaInput}
				onKeyDown={handleKeyDown}
				ref={setTextareaRef}
				value={value}
			/>
				{isDragActive && <div class="drop-hint">Drop to attach</div>}
			</div>
			<div class={`actions${clearAction || canAttachFile ? " with-tools" : ""}`}>
				{clearAction && (
					<button
						type="button"
						class="icon-action-button trash-button"
						aria-label={clearAction.label}
						data-tooltip={clearAction.label}
						title={clearAction.label}
						disabled={isDisabled}
						onClick={clearAction.onClick}
					>
						<TrashIcon />
						{/*
						{"🗑"}
						*/}
					</button>
				)}
				{canAttachFile && (
					<>
						<input
							accept={fileAccept}
							class="sr-only"
							disabled={isDisabled}
							multiple
							onChange={handleFileInput}
							ref={fileInputRef}
							type="file"
						/>
						<button
							aria-label="Add PDF, Word Doc"
							class="icon-action-button upload-button"
							data-tooltip="Add PDF, Word Doc"
							disabled={isDisabled}
							onClick={() => fileInputRef.current?.click()}
							title="Add PDF, Word Doc"
							type="button"
						>
							<PaperclipIcon />
						</button>
					</>
				)}
				<button type="submit" class="primary" disabled={isDisabled}>{actionLabel}</button>
			</div>
		</form>
	);
}
