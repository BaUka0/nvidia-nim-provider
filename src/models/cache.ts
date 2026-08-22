import {
  MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY,
  MODELS_CACHE_VERSION,
  MODELS_CACHE_VERSION_STATE_KEY,
  MODELS_STATE_KEY,
  RAW_MODELS_STATE_KEY,
} from "../shared/constants";
import { debugLog, outputLog } from "../shared/logging";
import type { NvidiaModelSummary } from "../types";
import { MODEL_LIST, type NormalizedNvidiaModel } from "./catalog";

export interface ModelCacheState {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

let modelCacheOperationQueue: Promise<void> = Promise.resolve();

/** Serialize discovery and manual refresh so rollback cannot clobber a newer cache write. */
export function runSerializedModelCacheOperation<T>(operation: () => Promise<T>): Promise<T> {
  const nextOperation = modelCacheOperationQueue.catch(() => undefined).then(operation);
  modelCacheOperationQueue = nextOperation.then(
    () => undefined,
    () => undefined,
  );
  return nextOperation;
}

/** Reset the shared serializer during extension teardown and between isolated tests. */
export function resetModelCacheOperationQueue(): void {
  modelCacheOperationQueue = Promise.resolve();
}

/** Commit all cache facets together, restoring the previous snapshot after any write failure. */
export async function writeModelCacheAtomically(
  globalState: ModelCacheState,
  rawModels: readonly NvidiaModelSummary[],
  normalizedModels: readonly NormalizedNvidiaModel[],
  keyFingerprint: string,
): Promise<void> {
  const entries: ReadonlyArray<readonly [string, unknown]> = [
    [RAW_MODELS_STATE_KEY, rawModels],
    [MODELS_STATE_KEY, normalizedModels],
    [MODELS_CACHE_VERSION_STATE_KEY, MODELS_CACHE_VERSION],
    [MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY, keyFingerprint],
  ];
  const previousValues = entries.map(([key]) => [key, globalState.get<unknown>(key)] as const);

  try {
    for (const [key, value] of entries) {
      await globalState.update(key, value);
    }
  } catch (writeError) {
    for (const [key, previousValue] of previousValues) {
      try {
        await globalState.update(key, previousValue);
      } catch (rollbackError) {
        debugLog(
          "modelCache",
          `Cache rollback failed for ${key}: ${
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }`,
        );
      }
    }
    throw writeError;
  }
}

export function reportMissingCuratedModels(rawModels: readonly NvidiaModelSummary[]): void {
  const apiModelIds = new Set(rawModels.map((model) => model.id));
  const missingCuratedModels = Object.keys(MODEL_LIST).filter(
    (modelId) => !apiModelIds.has(modelId),
  );
  if (missingCuratedModels.length > 0) {
    outputLog(
      "models",
      `Curated NVIDIA NIM models missing from the current API response: ${missingCuratedModels.join(
        ", ",
      )}`,
    );
  }
}
