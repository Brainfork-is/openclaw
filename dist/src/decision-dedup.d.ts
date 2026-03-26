/** Generate a SHA-256 fingerprint for a decision */
export declare function decisionFingerprint(decision: {
    decisionMade: string;
    reasoning: string;
}): string;
/** Check if a decision was already logged. If not, records its fingerprint. */
export declare function isDuplicateDecision(decision: {
    decisionMade: string;
    reasoning: string;
}): Promise<boolean>;
