interface RuntimeLimitEntry {
  limit: number;
  keyFingerprint: string;
  updatedAt: number;
}

export class ContextLimitStore {
  private readonly entries = new Map<string, RuntimeLimitEntry>();

  set(modelId: string, limit: number, keyFingerprint: string): void {
    this.entries.set(modelId, { limit, keyFingerprint, updatedAt: Date.now() });
  }

  get(modelId: string, keyFingerprint: string): number | undefined {
    const entry = this.entries.get(modelId);
    if (!entry) {
      return undefined;
    }
    if (entry.keyFingerprint !== keyFingerprint) {
      this.entries.delete(modelId);
      return undefined;
    }
    return entry.limit;
  }

  clear(): void {
    this.entries.clear();
  }
}
