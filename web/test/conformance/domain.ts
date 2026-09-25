/**
 * Domain interface for conformance tests
 * These steps call domain operations (via web/src/data/domain.ts).
 */

export interface DomainContext {
  keepCandidate(
    candidateId: string,
    options?: { stars?: number; tags?: string[]; name?: string; crates?: string[] }
  ): Promise<{ data?: unknown; errors?: unknown[] }>;

  skipCandidate(candidateId: string): Promise<{ data?: unknown; errors?: unknown[] }>;

  putOffCandidate(candidateId: string): Promise<{ data?: unknown; errors?: unknown[] }>;

  mergeMarkup(
    sampleId: string,
    clips: Array<{ kind: string; start: number; end: number; rank?: number; evidence?: unknown }>
  ): Promise<{ data?: unknown; errors?: unknown[] }>;

  saveScore(scoreId: string, aprText: string): Promise<{ data?: unknown; errors?: unknown[] }>;
}

/**
 * Create a real domain context that calls web/src/data/domain.ts functions
 */
export function createRealDomainContext(): DomainContext {
  // Import the domain functions at runtime
  const domainPromise = import("../../src/data/domain.js");

  return {
    async keepCandidate(candidateId, options) {
      const domain = await domainPromise;
      return domain.keepCandidate(candidateId, options);
    },

    async skipCandidate(candidateId) {
      const domain = await domainPromise;
      return domain.skipCandidate(candidateId);
    },

    async putOffCandidate(candidateId) {
      const domain = await domainPromise;
      return domain.putOffCandidate(candidateId);
    },

    async mergeMarkup(sampleId, clips) {
      const domain = await domainPromise;
      return domain.mergeMarkup(sampleId, clips);
    },

    async saveScore(scoreId, aprText) {
      const domain = await domainPromise;
      return domain.saveScore(scoreId, aprText);
    },
  };
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
