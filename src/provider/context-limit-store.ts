interface RuntimeLimitEntry {
  limit: number;
  keyFingerprint: string;
  updatedAt: number;
}

import { MIN_REPORTED_CONTEXT_LIMIT } from "../shared/constants";

export class ContextLimitStore {
  private readonly entries = new Map<string, RuntimeLimitEntry>();

  set(modelId: string, limit: number, keyFingerprint: string, catalogWindow?: number): void {
    if (!Number.isFinite(limit) || limit < MIN_REPORTED_CONTEXT_LIMIT) {
      return;
    }
    if (typeof catalogWindow === "number" && catalogWindow > 0) {
      if (limit > catalogWindow) {
        return;
      }
      if (limit < catalogWindow * 0.05) {
        return;
      }
    }
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
