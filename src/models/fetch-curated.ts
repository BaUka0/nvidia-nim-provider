import * as vscode from "vscode";
import { fetchModelsOrThrow } from "../api/client";
import { getApiKeyFingerprint } from "../api/key-resolver";
import { NormalizedNvidiaModel, normalizeNvidiaModels } from "./catalog";
import { reportMissingCuratedModels, writeModelCacheAtomically } from "./cache";
import { NvidiaModelSummary } from "../types";

export interface FetchedCuratedModels {
  rawModels: NvidiaModelSummary[];
  normalizedModels: NormalizedNvidiaModel[];
}

/**
 * Fetch the raw NIM model list, report curated-model drift, normalize against
 * MODEL_LIST, and persist the cache atomically. Shared by the background
 * refresh command and on-demand discovery so both paths build identical
 * caches. Returns undefined when the endpoint answered with malformed data.
 */
export async function fetchCuratedModels(input: {
  apiKey: string;
  userAgent: string;
  globalState?: vscode.Memento;
}): Promise<FetchedCuratedModels | undefined> {
  const rawModels = await fetchModelsOrThrow(input.apiKey, undefined, input.userAgent);
  if (!Array.isArray(rawModels)) {
    return undefined;
  }
  reportMissingCuratedModels(rawModels);
  const normalizedModels = normalizeNvidiaModels(rawModels);
  if (input.globalState) {
    await writeModelCacheAtomically(
      input.globalState,
      rawModels,
      normalizedModels,
      getApiKeyFingerprint(input.apiKey),
    );
  }
  return { rawModels, normalizedModels };
}
