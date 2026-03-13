const DECISION_SENTENCE = /\b(?:we(?:'ll| will| are going to)|decided to|decision is to|going forward|let's|adopt|standardize on|choose to)\b/i;
const NON_DURABLE = /\b(?:maybe|might|could|should consider|option|possible)\b/i;
function normalizeWhitespace(value) {
    return value.replace(/\s+/g, " ").trim();
}
function splitSentences(value) {
    return value
        .split(/(?<=[.!?])\s+/)
        .map((sentence) => normalizeWhitespace(sentence))
        .filter(Boolean);
}
function clip(value, maxLength) {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
function buildTitle(decisionMade) {
    return clip(decisionMade.replace(/[.!?]+$/, ""), 80);
}
function extractTextFromMessage(message) {
    if (!message || typeof message !== "object") {
        return null;
    }
    const role = message.role;
    if (role !== "user" && role !== "assistant") {
        return null;
    }
    const content = message.content;
    if (typeof content === "string") {
        const text = normalizeWhitespace(content);
        return text ? { role, text } : null;
    }
    if (!Array.isArray(content)) {
        return null;
    }
    const text = content
        .flatMap((block) => {
        if (block &&
            typeof block === "object" &&
            "type" in block &&
            block.type === "text" &&
            typeof block.text === "string") {
            return [block.text];
        }
        return [];
    })
        .join("\n");
    const normalized = normalizeWhitespace(text);
    return normalized ? { role, text: normalized } : null;
}
export function detectDurableDecisions(messages, limit = 3) {
    const turns = messages.map(extractTextFromMessage).filter(Boolean);
    const decisions = [];
    const seen = new Set();
    let lastUserText = "";
    for (const turn of turns) {
        if (turn.role === "user") {
            lastUserText = turn.text;
            continue;
        }
        for (const sentence of splitSentences(turn.text)) {
            if (!DECISION_SENTENCE.test(sentence) || NON_DURABLE.test(sentence) || sentence.includes("?")) {
                continue;
            }
            const normalizedSentence = sentence.toLowerCase();
            if (seen.has(normalizedSentence)) {
                continue;
            }
            seen.add(normalizedSentence);
            const reasoning = clip(turn.text, 1000);
            decisions.push({
                title: buildTitle(sentence),
                context: clip(lastUserText || "Derived from an OpenClaw conversation.", 400),
                decisionNeeded: clip(lastUserText || "Capture the agreed approach from this conversation.", 240),
                decisionMade: clip(sentence, 300),
                reasoning,
                tags: ["openclaw", "memory"],
            });
            if (decisions.length >= limit) {
                return decisions;
            }
        }
    }
    return decisions;
}
//# sourceMappingURL=decision-capture.js.map