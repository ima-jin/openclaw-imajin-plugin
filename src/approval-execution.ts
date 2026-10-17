/**
 * Shared by every approval execution rail in one plugin runtime.
 *
 * Claim only after authorization and drift checks, immediately before calling
 * the harness. A thrown/ambiguous harness reply MUST NOT release the claim:
 * execution may already have happened. Deliberately no eviction or release.
 */
/** Public ownership attestation fields; harness keys never leave the plugin. */
export interface ApprovalLoopBinding {
  loopId: string;
  principalDid: string;
  agentDid: string;
  approvalId: string;
}

export class ApprovalExecutionRegistry {
  private readonly claimed = new Set<string>();
  private readonly bindings = new Map<string, ApprovalLoopBinding>();

  /** Only locally resolved ownership may bind an approval. Reassignment fails closed. */
  bind(binding: ApprovalLoopBinding): void {
    const previous = this.bindings.get(binding.approvalId);
    if (previous && (
      previous.loopId !== binding.loopId ||
      previous.principalDid !== binding.principalDid ||
      previous.agentDid !== binding.agentDid
    )) {
      throw new Error("approval binding conflict");
    }
    if (!previous) this.bindings.set(binding.approvalId, Object.freeze({
      loopId: binding.loopId,
      principalDid: binding.principalDid,
      agentDid: binding.agentDid,
      approvalId: binding.approvalId,
    }));
  }

  getBinding(approvalId: string): ApprovalLoopBinding | undefined {
    return this.bindings.get(approvalId);
  }

  claim(approvalId: string): boolean {
    if (!approvalId.trim() || this.claimed.has(approvalId)) return false;
    this.claimed.add(approvalId);
    return true;
  }
}
