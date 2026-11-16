import { BoundedMap } from "../shared/bounded-map";
import { MIN_REPORTED_CONTEXT_LIMIT } from "../shared/constants";

const MAX_CONTEXT_LIMIT_ENTRIES = 256;

function makeStoreKey(modelId: string, keyFingerprint: string): string {
  return `${keyFingerprint}\u0000${modelId}`;
}

export class ContextLimitStore {
  private readonly entries = new BoundedMap<string, number>(MAX_CONTEXT_LIMIT_ENTRIES);

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
    this.entries.set(makeStoreKey(modelId, keyFingerprint), limit);
  }

  get(modelId: string, keyFingerprint: string): number | undefined {
    return this.entries.get(makeStoreKey(modelId, keyFingerprint));
  }

  clear(): void {
    this.entries.clear();
  }
}
