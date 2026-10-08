import { useEffect, useRef } from "preact/hooks";
import { MessageContent } from "./MessageContent.js";
import { hasCopyableLlmText, CopyButton } from "../common/CopyButton.js";

export function MessageList({ className = "", messages }) {
	const messagesRef = useRef(null);
	const isAskMessages = className.split(/\s+/).includes("ask-messages");

	useEffect(() => {
		const element = messagesRef.current;
		if (element) {
			element.scrollTop = element.scrollHeight;
		}
	}, [messages]);

	return (
		<div class={`messages${className ? ` ${className}` : ""}`} ref={messagesRef} aria-live="polite">
			{messages.map((message) => {
				const canCopy = (
					isAskMessages
					&& message.role === "assistant"
					&& !message.error
					&& typeof message.text === "string"
					&& message.copyable === true
					&& hasCopyableLlmText(message.text)
				);

				return (
					<article class={`message ${message.role}${message.error ? " error" : ""}`} key={message.id}>
						<div class="message-stack">
							<div class="bubble">
								<MessageContent message={message} />
							</div>
							{canCopy && (
								<div class="message-copy-row">
									<CopyButton className="message-copy-button" text={message.text} />
								</div>
							)}
						</div>
					</article>
				);
			})}
		</div>
	);
}
