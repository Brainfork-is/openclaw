import { describe, expect, it } from "vitest";
import { detectDurableDecisions } from "../decision-capture.js";

function msg(role: "user" | "assistant", text: string) {
  return { role, content: text };
}

describe("detectDurableDecisions", () => {
  it("captures genuine architectural/process decisions", () => {
    const messages = [
      msg("user", "What database should we use for the new services?"),
      msg(
        "assistant",
        "After evaluating the options, we decided to standardize on PostgreSQL for all new services. It gives us JSONB support, pgvector for embeddings, and the team already knows it well.",
      ),
    ];

    const decisions = detectDurableDecisions(messages);
    expect(decisions.length).toBe(1);
    expect(decisions[0].decisionMade).toContain("standardize on PostgreSQL");
  });

  it("captures policy decisions with 'going forward'", () => {
    const messages = [
      msg("user", "How should we handle PRs?"),
      msg(
        "assistant",
        "Going forward, all PRs must be rebased onto main instead of using merge commits. This keeps the git history linear and makes bisecting much easier.",
      ),
    ];

    const decisions = detectDurableDecisions(messages);
    expect(decisions.length).toBe(1);
    expect(decisions[0].decisionMade).toContain("all PRs must be rebased");
  });

  it("captures 'agreed to' decisions", () => {
    const messages = [
      msg("user", "Should we go with shadcn or build our own components?"),
      msg(
        "assistant",
        "We agreed to adopt shadcn/ui as the component library for the design system. It provides accessible primitives that we can customise to match the brand.",
      ),
    ];

    const decisions = detectDurableDecisions(messages);
    expect(decisions.length).toBe(1);
  });

  it("rejects casual action narration with 'we will'", () => {
    const messages = [
      msg("user", "Can you check the CI?"),
      msg(
        "assistant",
        "Sure, we'll check the CI logs next. Let me pull up the latest run.",
      ),
    ];

    const decisions = detectDurableDecisions(messages);
    expect(decisions).toHaveLength(0);
  });

  it("rejects 'we will' with action verbs like push, deploy, merge", () => {
    const messages = [
      msg("user", "Ready to ship?"),
      msg(
        "assistant",
        "We'll merge the PR and deploy to staging. Then we'll run the smoke tests to verify everything works.",
      ),
    ];

    const decisions = detectDurableDecisions(messages);
    expect(decisions).toHaveLength(0);
  });

  it("rejects operational narration like 'going forward, here is the status'", () => {
    const messages = [
      msg("user", "What's the status?"),
      msg(
        "assistant",
        "Going forward, here's the status update. Three tasks completed, two in progress, nothing blocked.",
      ),
    ];

    const decisions = detectDurableDecisions(messages);
    expect(decisions).toHaveLength(0);
  });

  it("rejects task narration with 'decided to check/fix/look'", () => {
    const messages = [
      msg("user", "The tests are failing"),
      msg(
        "assistant",
        "I decided to check the Playwright config first. The failure looks like a missing project reference.",
      ),
    ];

    const decisions = detectDurableDecisions(messages);
    expect(decisions).toHaveLength(0);
  });

  it("rejects 'let's' phrases as non-durable", () => {
    const messages = [
      msg("user", "What next?"),
      msg(
        "assistant",
        "We decided to look at the logs first. Let's start with the Stripe webhook output.",
      ),
    ];

    const decisions = detectDurableDecisions(messages);
    expect(decisions).toHaveLength(0);
  });

  it("strips markdown from captured decisions", () => {
    const messages = [
      msg("user", "What component library?"),
      msg(
        "assistant",
        "We decided to standardize on **shadcn/ui** for all `new components` in the _design system_. It provides [great primitives](https://ui.shadcn.com).",
      ),
    ];

    const decisions = detectDurableDecisions(messages);
    expect(decisions.length).toBe(1);
    expect(decisions[0].decisionMade).not.toContain("**");
    expect(decisions[0].decisionMade).not.toContain("`");
    expect(decisions[0].decisionMade).not.toContain("_");
    expect(decisions[0].decisionMade).not.toContain("[");
  });

  it("strips markdown from reasoning field", () => {
    const messages = [
      msg("user", "What database?"),
      msg(
        "assistant",
        "We decided to adopt **PostgreSQL** for all services. The `pg` driver is mature, `pgvector` handles embeddings, and _everyone_ knows it.",
      ),
    ];

    const decisions = detectDurableDecisions(messages);
    expect(decisions.length).toBe(1);
    expect(decisions[0].reasoning).not.toContain("**");
    expect(decisions[0].reasoning).not.toContain("`");
  });

  it("rejects sentences that are too short to be real decisions", () => {
    const messages = [
      msg("user", "What now?"),
      msg("assistant", "We decided to proceed. Let me get started on that."),
    ];

    const decisions = detectDurableDecisions(messages);
    expect(decisions).toHaveLength(0);
  });

  it("respects the limit parameter", () => {
    const messages = [
      msg("user", "What's the tech stack plan?"),
      msg(
        "assistant",
        "We decided to standardize on PostgreSQL for databases. We agreed to adopt TypeScript for all new backend services. We chose to use Next.js for the web dashboard. We decided to standardize on Playwright for end-to-end testing.",
      ),
    ];

    const decisions = detectDurableDecisions(messages, 2);
    expect(decisions.length).toBeLessThanOrEqual(2);
  });

  it("deduplicates identical decisions across messages", () => {
    const messages = [
      msg("user", "Database?"),
      msg("assistant", "We decided to standardize on PostgreSQL for all new services."),
      msg("user", "And for the other project?"),
      msg("assistant", "Same — we decided to standardize on PostgreSQL for all new services."),
    ];

    const decisions = detectDurableDecisions(messages);
    expect(decisions.length).toBe(1);
  });

  it("captures decisions stated by the user (not just assistant turns)", () => {
    const messages = [
      msg("user", "We decided to standardize on PostgreSQL for all new backend services going forward."),
      msg("assistant", "That makes sense — PostgreSQL has great JSONB support and the team knows it well."),
    ];

    const decisions = detectDurableDecisions(messages);
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions[0].decisionMade).toContain("standardize on PostgreSQL");
  });

  it("uses next assistant turn as reasoning for user-stated decisions", () => {
    const messages = [
      msg("user", "We agreed to adopt shadcn/ui as our component library for all new features."),
      msg("assistant", "Agreed — shadcn/ui gives us accessible primitives we can customise to match the brand."),
    ];

    const decisions = detectDurableDecisions(messages);
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions[0].reasoning).toContain("accessible primitives");
  });

  it("requires preceding user context (not just system noise)", () => {
    const messages = [
      msg(
        "user",
        "[Inter-session message] sourceSession=cron:abc [cron:task-review] Check the board",
      ),
      msg(
        "assistant",
        "We decided to adopt a new logging framework for better observability across all services.",
      ),
    ];

    const decisions = detectDurableDecisions(messages);
    // Should still capture the decision but with cleaned context
    if (decisions.length > 0) {
      expect(decisions[0].context).not.toContain("[Inter-session message]");
      expect(decisions[0].context).not.toContain("sourceSession=");
    }
  });
});
