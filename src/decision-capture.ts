type ConversationTurn = {
  role: "user" | "assistant";
  text: string;
};

export type CapturedDecision = {
  title: string;
  context: string;
  decisionNeeded: string;
  decisionMade: string;
  reasoning: string;
  tags: string[];
  metadata?: Record<string, unknown>;
};

/**
 * Match only strong decision language that implies a durable choice.
 * Deliberately excludes "we'll" / "we will" / "we are going to" because
 * those match almost any forward-looking sentence ("we'll check the logs").
 * The "going forward" variant requires a follow-up policy word (must/always/never/all/every/no).
 */
/**
 * Match only strong decision language that implies a durable choice.
 * The "going forward" variant matches when the sentence also contains
 * a policy word (must/always/never/all/every/no) anywhere after it.
 */
const DECISION_SENTENCE =
  /\b(?:decided to|decision is to|adopt(?:ed|ing)\b|standardize(?:d)? on|chose to|choose to|agreed to|the (?:plan|rule|policy|standard) is to|we're going with)\b/i;

/** "Going forward" is only a decision when the sentence also contains a policy signal */
const GOING_FORWARD = /\bgoing forward\b/i;
const POLICY_SIGNAL = /\b(?:must|always|never|all\b|every\b|no\b|instead of|rather than|not\b|require|standard)\b/i;

const NON_DURABLE = /\b(?:maybe|might|could|should consider|option|possible|let me|let's see|let's check|let's look|let's try|let's run|let's test|let's write|let's build|let's start|let's move|let's go|let's do|let's get|now let's)\b/i;

/**
 * Action verbs that follow a decision verb like "decided to" indicate narration
 * ("I decided to check the logs") not policy. Only applied to direct-decision
 * sentences, not "going forward" policy statements where action verbs may appear
 * as the subject of the policy.
 */
const ACTION_VERB_AFTER_DECISION =
  /\b(?:decided to|chose to|choose to|agreed to)\s+(?:check|look at|fix|push|merge|deploy|run|pull|create|start|install|update|commit|revert|debug|test|build|ship|resolve|read|open|close|delete|remove|move|copy|set up)\b/i;

/** Filter out sentences that are just narration or internal system noise */
const NARRATION_NOISE =
  /^(?:now |next |first |then |finally |ok |okay |alright |right |sure |yes |yeah )/i;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function splitSentences(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => normalizeWhitespace(sentence))
    .filter(Boolean);
}

/** Strip internal OpenClaw metadata from user text so decisions have clean context */
function stripInternalMetadata(value: string): string {
  return value
    .replace(/\[Inter-session message\][^\n]*/g, "")
    .replace(/OpenClaw runtime context \(internal\):[^\n]*/g, "")
    .replace(/\[Internal task completion event\][^\n]*/g, "")
    .replace(/Conversation info \(untrusted metadata\):[\s\S]*?```\s*/g, "")
    .replace(/Sender \(untrusted metadata\):[\s\S]*?```\s*/g, "")
    // Telegram/channel message metadata JSON blocks (fenced or bare)
    .replace(/```\s*json\s*\{[^}]*"message_id"[^}]*\}\s*```/g, "")
    .replace(/```\s*json\s*\{[^}]*"sender_id"[^}]*\}\s*```/g, "")
    .replace(/```\s*json\s*\{[^}]*"label"[^}]*\}\s*```/g, "")
    .replace(/\bjson\s*\{\s*"message_id"\s*:[^}]*\}/g, "")
    .replace(/\bjson\s*\{\s*"label"\s*:[^}]*\}/g, "")
    .replace(/\bjson\s*\{\s*"sender_id"\s*:[^}]*\}/g, "")
    // System event lines (exec completions, cron triggers)
    .replace(/System:\s*\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*[^\n]*/g, "")
    .replace(/sourceSession=[^\s]*/g, "")
    .replace(/sourceChannel=[^\s]*/g, "")
    .replace(/sourceTool=[^\s]*/g, "")
    .replace(/\[cron:[^\]]*\]/g, "")
    // Internal action markers
    .replace(/\[\[replytocurrent\]\]/gi, "")
    .replace(/\[\[reply\]\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip internal metadata from assistant reasoning text */
function stripReasoningMetadata(value: string): string {
  return value
    .replace(/\[\[replytocurrent\]\]/gi, "")
    .replace(/\[\[reply\]\]/gi, "")
    // Telegram/channel message metadata JSON blocks
    .replace(/```\s*json\s*\{[^}]*"message_id"[^}]*\}\s*```/g, "")
    .replace(/```\s*json\s*\{[^}]*"sender_id"[^}]*\}\s*```/g, "")
    .replace(/```\s*json\s*\{[^}]*"label"[^}]*\}\s*```/g, "")
    .replace(/\bjson\s*\{\s*"message_id"\s*:[^}]*\}/g, "")
    .replace(/\bjson\s*\{\s*"label"\s*:[^}]*\}/g, "")
    // System event lines
    .replace(/System:\s*\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** Strip common markdown syntax so stored decisions/reasoning are plain text */
function stripMarkdown(value: string): string {
  return value
    // Bold/italic: **text**, __text__, *text*, _text_
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    // Inline code: `text`
    .replace(/`([^`]+)`/g, "$1")
    // Links: [text](url)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Images: ![alt](url)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    // Headers: # text
    .replace(/^#{1,6}\s+/gm, "")
    // Blockquotes: > text
    .replace(/^>\s+/gm, "")
    // Horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .trim();
}

function buildTitle(decisionMade: string): string {
  return clip(decisionMade.replace(/[.!?]+$/, ""), 80);
}

function extractTextFromMessage(message: unknown): ConversationTurn | null {
  if (!message || typeof message !== "object") {
    return null;
  }

  const role = (message as { role?: unknown }).role;
  if (role !== "user" && role !== "assistant") {
    return null;
  }

  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    const text = normalizeWhitespace(content);
    return text ? { role, text } : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .flatMap((block) => {
      if (
        block &&
        typeof block === "object" &&
        "type" in block &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return [(block as { text: string }).text];
      }
      return [];
    })
    .join("\n");

  const normalized = normalizeWhitespace(text);
  return normalized ? { role, text: normalized } : null;
}

export function detectDurableDecisions(messages: unknown[], limit = 3): CapturedDecision[] {
  const turns = messages.map(extractTextFromMessage).filter(Boolean) as ConversationTurn[];
  const decisions: CapturedDecision[] = [];
  const seen = new Set<string>();
  let lastUserText = "";

  for (const turn of turns) {
    if (turn.role === "user") {
      lastUserText = turn.text;
    }

    // Evaluate both user and assistant turns; strip internal metadata from user text first
    const textForEval = turn.role === "user" ? stripInternalMetadata(turn.text) : turn.text;

    for (const sentence of splitSentences(textForEval)) {
      const isDirectDecision = DECISION_SENTENCE.test(sentence);
      const isGoingForwardPolicy = GOING_FORWARD.test(sentence) && POLICY_SIGNAL.test(sentence);
      if ((!isDirectDecision && !isGoingForwardPolicy) || NON_DURABLE.test(sentence) || sentence.includes("?")) {
        continue;
      }

      // Skip short narration sentences and noise
      if (NARRATION_NOISE.test(sentence) || sentence.length < 30) {
        continue;
      }

      // Skip sentences that narrate immediate actions rather than declaring policy.
      // Only apply when the decision verb directly precedes an action verb
      // (e.g., "decided to check" is narration, but "all PRs must be rebased
      // instead of using merge commits" is policy that happens to mention actions).
      if (isDirectDecision && ACTION_VERB_AFTER_DECISION.test(sentence)) {
        continue;
      }

      const cleanSentence = stripMarkdown(sentence);
      // For dedup, extract the decision core by stripping leading filler
      // ("Same — we decided..." → "we decided...")
      const dedupeKey = cleanSentence
        .toLowerCase()
        .replace(/\s+/g, " ")
        .replace(/^(?:same\b|also\b|again\b|yes\b|yeah\b|right\b)[^a-z]*/i, "")
        .replace(/^[\s—–-]+/, "")
        .trim();
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      const reasoning = stripReasoningMetadata(stripMarkdown(clip(textForEval, 1000)));
      const cleanContext = turn.role === "user"
        ? (textForEval || "Derived from an OpenClaw conversation.")
        : (stripInternalMetadata(lastUserText) || "Derived from an OpenClaw conversation.");
      decisions.push({
        title: buildTitle(cleanSentence),
        context: clip(cleanContext, 400),
        decisionNeeded: clip(cleanContext, 240),
        decisionMade: clip(cleanSentence, 300),
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
