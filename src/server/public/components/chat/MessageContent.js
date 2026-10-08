import { MutationContent } from "./MutationContent.js";
import { TripletContent } from "./TripletContent.js";
import { MarkdownPreview } from "../common/MarkdownPreview.js";

export function MessageContent({ message }) {
	if (message.mutation) {
		return <MutationContent mutation={message.mutation} />;
	}

	if (message.triplets) {
		return <TripletContent triplets={message.triplets} />;
	}

	if (message.role === "assistant" && typeof message.text === "string" && !message.error) {
		return <MarkdownPreview text={message.text} />;
	}

	return message.text;
}
