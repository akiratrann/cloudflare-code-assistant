import type { LanguageModelV3Prompt, SharedV3ProviderOptions } from "@ai-sdk/provider";
import type { WorkersAIChatPrompt } from "./workersai-chat-prompt";

export function convertToWorkersAIChatMessages(prompt: LanguageModelV3Prompt): {
	messages: WorkersAIChatPrompt;
	images: {
		mediaType: string | undefined;
		image: Uint8Array;
		providerOptions: SharedV3ProviderOptions | undefined;
	}[];
} {
	const messages: WorkersAIChatPrompt = [];
	const images: {
		mediaType: string | undefined;
		image: Uint8Array;
		providerOptions: SharedV3ProviderOptions | undefined;
	}[] = [];

	for (const { role, content } of prompt) {
		switch (role) {
			case "system": {
				messages.push({ content, role: "system" });
				break;
			}

			case "user": {
				const textParts: string[] = [];

				for (const part of content) {
					switch (part.type) {
						case "text": {
							textParts.push(part.text);
							break;
						}
						case "file": {
							if (part.data instanceof Uint8Array) {
								images.push({
									image: part.data,
									mediaType: part.mediaType,
									providerOptions: part.providerOptions,
								});
							}
							// Don't push empty strings for image parts
							break;
						}
					}
				}

				messages.push({
					content: textParts.join("\n"),
					role: "user",
				});
				break;
			}

			case "assistant": {
				let text = "";
				const toolCalls: Array<{
					id: string;
					type: "function";
					function: { name: string; arguments: string };
				}> = [];

				for (const part of content) {
					switch (part.type) {
						case "text": {
							text += part.text;
							break;
						}

						case "reasoning": {
							// Reasoning is passed through to text for the message conversion,
							// since Workers AI doesn't have a separate reasoning field in messages
							text += part.text;
							break;
						}

						case "file": {
							// File parts in assistant messages - no action needed
							break;
						}

						case "tool-call": {
							toolCalls.push({
								function: {
									arguments: JSON.stringify(part.input),
									name: part.toolName,
								},
								id: part.toolCallId,
								type: "function",
							});
							break;
						}

						case "tool-result": {
							// Tool results in assistant messages - no action needed
							break;
						}

						default: {
							const exhaustiveCheck = part satisfies never;
							throw new Error(
								`Unsupported part type: ${(exhaustiveCheck as { type: string }).type}`,
							);
						}
					}
				}

				messages.push({
					content: text,
					role: "assistant",
					tool_calls:
						toolCalls.length > 0
							? toolCalls.map(({ function: { name, arguments: args }, id }) => ({
									function: { arguments: args, name },
									id,
									type: "function" as const,
								}))
							: undefined,
				});

				break;
			}

			case "tool": {
				for (const toolResponse of content) {
					if (toolResponse.type === "tool-result") {
						messages.push({
							content: JSON.stringify(toolResponse.output),
							name: toolResponse.toolName,
							tool_call_id: toolResponse.toolCallId,
							role: "tool",
						});
					}
					// Skip tool-approval-response parts as they're not supported by Workers AI
				}
				break;
			}

			default: {
				const exhaustiveCheck = role satisfies never;
				throw new Error(`Unsupported role: ${exhaustiveCheck}`);
			}
		}
	}

	return { images, messages };
}
