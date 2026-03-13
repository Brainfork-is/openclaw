export type CapturedDecision = {
    title: string;
    context: string;
    decisionNeeded: string;
    decisionMade: string;
    reasoning: string;
    tags: string[];
};
export declare function detectDurableDecisions(messages: unknown[], limit?: number): CapturedDecision[];
