const DECISION_SENTENCE = /\b(?:we(?:'ll| will| are going to)|decided to|decision is to|going forward,?\s+we|adopt(?:ed|ing)?\b|standardize on|choose to|chose to|agreed to|the plan is to|we're going with)\b/i;
const NON_DURABLE = /\b(?:maybe|might|could|should consider|option|possible|let me|let's see|let's check|let's look|let's try|let's run|let's test|let's write|let's build|let's start|let's move|let's go|let's do|let's get|now let's)\b/i;
/** Filter out sentences that are just narration or internal system noise */
const NARRATION_NOISE = /^(?:now |next |first |then |finally |ok |okay |alright |right )/i;
function normalizeWhitespace(value) {
    return value.replace(/\s+/g, " ").trim();
}
function splitSentences(value) {
    return value
        .split(/(?<=[.!?])\s+/)
        .map((sentence) => normalizeWhitespace(sentence))
        .filter(Boolean);
}
/** Strip internal OpenClaw metadata from user text so decisions have clean context */
function stripInternalMetadata(value) {
    return value
        .replace(/\[Inter-session message\][^\n]*/g, "")
        .replace(/OpenClaw runtime context \(internal\):[^\n]*/g, "")
        .replace(/\[Internal task completion event\][^\n]*/g, "")
        .replace(/Conversation info \(untrusted metadata\):[\s\S]*?```\s*/g, "")
        .replace(/Sender \(untrusted metadata\):[\s\S]*?```\s*/g, "")
        .replace(/sourceSession=[^\s]*/g, "")
        .replace(/sourceChannel=[^\s]*/g, "")
        .replace(/sourceTool=[^\s]*/g, "")
        .replace(/\[cron:[^\]]*\]/g, "")
        .replace(/\s+/g, " ")
        .trim();
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
            // Skip short narration sentences and noise
            if (NARRATION_NOISE.test(sentence) || sentence.length < 30) {
                continue;
            }
            const normalizedSentence = sentence.toLowerCase();
            if (seen.has(normalizedSentence)) {
                continue;
            }
            seen.add(normalizedSentence);
            const reasoning = clip(turn.text, 1000);
            const cleanContext = stripInternalMetadata(lastUserText) || "Derived from an OpenClaw conversation.";
            decisions.push({
                title: buildTitle(sentence),
                context: clip(cleanContext, 400),
                decisionNeeded: clip(cleanContext, 240),
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