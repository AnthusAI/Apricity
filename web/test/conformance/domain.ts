/**
 * Domain interface for conformance tests
 * These steps call domain operations (via web/src/data/domain.ts, not yet implemented).
 * For now, mark scenarios using these steps as pending with a clear message.
 */

export interface DomainContext {
  keepCandidate(
    candidateId: string,
    options?: { stars?: number; tags?: string[]; name?: string; crates?: string[] }
  ): Promise<{ data?: unknown; errors?: unknown[] }>;

  skipCandidate(candidateId: string): Promise<{ data?: unknown; errors?: unknown[] }>;

  putOffCandidate(candidateId: string): Promise<{ data?: unknown; errors?: unknown[] }>;

  mergeMarkup(
    clipId: string,
    slices: Array<{ kind: string; start: number; end: number; rank?: number; evidence?: unknown }>
  ): Promise<{ data?: unknown; errors?: unknown[] }>;

  saveScore(scoreId: string, aprText: string): Promise<{ data?: unknown; errors?: unknown[] }>;
}

/**
 * Create a stub domain context that marks operations as pending
 */
export function createPendingDomainContext(): DomainContext {
  const pendingError = () => {
    throw new Error("Domain operations not yet implemented (web/src/data/domain.ts)");
  };

  return {
    keepCandidate: pendingError,
    skipCandidate: pendingError,
    putOffCandidate: pendingError,
    mergeMarkup: pendingError,
    saveScore: pendingError,
  };
}
