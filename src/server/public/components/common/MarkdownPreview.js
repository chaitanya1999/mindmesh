
function markdownBlocks(text) {
	const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
	const blocks = [];
	let paragraph = [];
	let list = null;

	function flushParagraph() {
		if (paragraph.length > 0) {
			blocks.push({ type: "paragraph", lines: paragraph });
			paragraph = [];
		}
	}

	function flushList() {
		if (list) {
			blocks.push(list);
			list = null;
		}
	}

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const trimmed = line.trim();

		if (!trimmed) {
			flushParagraph();
			flushList();
			continue;
		}

		if (trimmed.startsWith("```")) {
			flushParagraph();
			flushList();
			const codeLines = [];
			index += 1;
			while (index < lines.length && !lines[index].trim().startsWith("```")) {
				codeLines.push(lines[index]);
				index += 1;
			}
			blocks.push({ type: "code", text: codeLines.join("\n") });
			continue;
		}

		const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
		if (heading) {
			flushParagraph();
			flushList();
			blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
			continue;
		}

		const unorderedItem = /^[-*+]\s+(.+)$/.exec(trimmed);
		const orderedItem = /^\d+[.)]\s+(.+)$/.exec(trimmed);
		if (unorderedItem || orderedItem) {
			flushParagraph();
			const listType = unorderedItem ? "unordered-list" : "ordered-list";
			if (!list || list.type !== listType) {
				flushList();
				list = { type: listType, items: [] };
			}
			list.items.push(unorderedItem?.[1] ?? orderedItem[1]);
			continue;
		}

		flushList();
		paragraph.push(line);
	}

	flushParagraph();
	flushList();
	return blocks;
}

function renderInlineMarkdown(text, keyPrefix) {
	const value = String(text ?? "");
	const parts = [];
	const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
	let cursor = 0;
	let match = pattern.exec(value);

	while (match) {
		if (match.index > cursor) {
			parts.push(value.slice(cursor, match.index));
		}

		const token = match[0];
		if (token.startsWith("`")) {
			parts.push(<code key={`${keyPrefix}-code-${match.index}`}>{token.slice(1, -1)}</code>);
		} else {
			parts.push(<strong key={`${keyPrefix}-strong-${match.index}`}>{token.slice(2, -2)}</strong>);
		}

		cursor = match.index + token.length;
		match = pattern.exec(value);
	}

	if (cursor < value.length) {
		parts.push(value.slice(cursor));
	}

	return parts;
}

export function MarkdownPreview({ className = "", emptyText = "No preview text yet.", text }) {
	const blocks = markdownBlocks(text);

	return (
		<div class={`markdown-preview${className ? ` ${className}` : ""}`}>
			{blocks.length === 0 ? (
				<p class="muted-copy">{emptyText}</p>
			) : blocks.map((block, blockIndex) => {
				if (block.type === "heading") {
					const HeadingTag = `h${Math.min(block.level + 2, 6)}`;
					return (
						<HeadingTag key={`heading-${blockIndex}`}>
							{renderInlineMarkdown(block.text, `heading-${blockIndex}`)}
						</HeadingTag>
					);
				}

				if (block.type === "code") {
					return (
						<pre key={`code-${blockIndex}`}>
							<code>{block.text}</code>
						</pre>
					);
				}

				if (block.type === "unordered-list" || block.type === "ordered-list") {
					const ListTag = block.type === "ordered-list" ? "ol" : "ul";
					return (
						<ListTag key={`list-${blockIndex}`}>
							{block.items.map((item, itemIndex) => (
								<li key={`item-${blockIndex}-${itemIndex}`}>
									{renderInlineMarkdown(item, `item-${blockIndex}-${itemIndex}`)}
								</li>
							))}
						</ListTag>
					);
				}

				return (
					<p key={`paragraph-${blockIndex}`}>
						{block.lines.map((line, lineIndex) => (
							<span key={`line-${blockIndex}-${lineIndex}`}>
								{lineIndex > 0 && <br />}
								{renderInlineMarkdown(line, `line-${blockIndex}-${lineIndex}`)}
							</span>
						))}
					</p>
				);
			})}
		</div>
	);
}
