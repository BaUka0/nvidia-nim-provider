import { createHash } from "node:crypto";

import { SECRET_STORAGE_KEY } from "../shared/constants";

export interface ApiKeySecretStorage {
  get(key: string): PromiseLike<string | undefined>;
}

export type ApiKeyResolutionSource = "configured" | "runtime" | "legacy";

export interface ResolvedApiKey {
  value: string;
  source: ApiKeyResolutionSource;
}

export interface ToolApiKeyResolutionOptions {
  /** Fingerprint of the cache whose model will be used by the tool. */
  cacheKeyFingerprint?: string;
  /** Manual refresh may intentionally replace a cache whose former owner disappeared. */
  allowUnmatchedRuntimeKey?: boolean;
}

const DEFAULT_RUNTIME_GROUP = "<runtime>";
const MODEL_KEY_BINDING_PROPERTY = "__nvidiaNimRuntimeKeyBinding";

interface RuntimeModelBinding {
  bindingId: string;
}

function normalizeApiKey(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Return a non-reversible cache owner marker for an API key. */
export function getApiKeyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

function getRuntimeBindingId(groupId: string, apiKey: string): string {
  return createHash("sha256").update(groupId).update("\0").update(apiKey).digest("hex");
}

/**
 * Resolves provider-group keys and legacy SecretStorage keys without putting
 * the raw key in LanguageModelChatInformation. Each provider group receives
 * an opaque binding token so cloned model objects can still resolve the
 * correct key when several groups expose the same model ID.
 */
export class NvidiaApiKeyResolver {
  private modelBindings = new WeakMap<object, RuntimeModelBinding>();
  private readonly runtimeKeysByGroup = new Map<string, string>();
  private readonly runtimeKeysByBinding = new Map<string, string>();
  private readonly bindingGroups = new Map<string, string>();
  private readonly bindingsByGroup = new Map<string, Set<string>>();
  private readonly bindingsByModelId = new Map<string, Set<string>>();

  constructor(private readonly secrets: ApiKeySecretStorage) {}

  normalize(value: unknown): string | undefined {
    return normalizeApiKey(value);
  }

  async resolveConfiguredOrLegacy(configuredApiKey?: unknown): Promise<ResolvedApiKey | undefined> {
    const configured = normalizeApiKey(configuredApiKey);
    if (configured) {
      return { value: configured, source: "configured" };
    }

    const legacy = normalizeApiKey(await this.secrets.get(SECRET_STORAGE_KEY));
    return legacy ? { value: legacy, source: "legacy" } : undefined;
  }

  registerModelKey(model: object, apiKey: string, groupId = DEFAULT_RUNTIME_GROUP): void {
    const normalized = normalizeApiKey(apiKey);
    if (!normalized) {
      return;
    }

    this.rememberRuntimeKey(normalized, groupId);
    const bindingId = getRuntimeBindingId(groupId, normalized);
    this.runtimeKeysByBinding.set(bindingId, normalized);
    this.bindingGroups.set(bindingId, groupId);
    this.getOrCreateSet(this.bindingsByGroup, groupId).add(bindingId);
    this.modelBindings.set(model, { bindingId });

    // The opaque token is intentionally enumerable because VS Code can clone
    // provider model information before invoking the response callback.
    try {
      Object.defineProperty(model, MODEL_KEY_BINDING_PROPERTY, {
        value: bindingId,
        configurable: true,
        enumerable: true,
      });
    } catch {
      // Frozen model objects still work through the WeakMap and unique-ID
      // fallback. Ambiguous cloned IDs fail closed instead of using a wrong key.
    }

    const id = this.getModelId(model);
    if (id) {
      this.getOrCreateSet(this.bindingsByModelId, id).add(bindingId);
    }
  }

  rememberRuntimeKey(apiKey: unknown, groupId = DEFAULT_RUNTIME_GROUP): void {
    const normalized = normalizeApiKey(apiKey);
    if (!normalized) {
      return;
    }

    const previousKey = this.runtimeKeysByGroup.get(groupId);
    if (previousKey && previousKey !== normalized) {
      this.clearRuntimeBindings(groupId);
    }
    this.runtimeKeysByGroup.set(groupId, normalized);
  }

  async resolveForModel(model: object): Promise<ResolvedApiKey | undefined> {
    const weakBinding = this.modelBindings.get(model)?.bindingId;
    const serializedBinding = this.getSerializedBindingId(model);
    const hasBindingMarker = Boolean(weakBinding || serializedBinding);
    const directRuntime =
      this.resolveBindingKey(weakBinding) ?? this.resolveBindingKey(serializedBinding);
    if (directRuntime) {
      return { value: directRuntime, source: "runtime" };
    }

    const modelId = this.getModelId(model);
    // A cloned model can retain a binding token after its provider group was
    // removed or its key changed. Never let that stale object fall through to
    // an active binding from a different group that happens to expose the
    // same model ID. When no runtime group remains at all, legacy SecretStorage
    // fallback is still allowed for backwards compatibility; during a key
    // change, however, do not use a legacy key while the replacement binding
    // is still being resolved.
    if (hasBindingMarker) {
      const hasActiveBindingForModel =
        modelId !== undefined &&
        [...(this.bindingsByModelId.get(modelId) ?? [])].some((bindingId) =>
          Boolean(this.resolveBindingKey(bindingId)),
        );
      if (modelId === undefined || hasActiveBindingForModel || this.runtimeKeysByGroup.size > 0) {
        return undefined;
      }
    }
    if (modelId) {
      const matchingKeys = new Set<string>();
      for (const bindingId of this.bindingsByModelId.get(modelId) ?? []) {
        const key = this.resolveBindingKey(bindingId);
        if (key) {
          matchingKeys.add(key);
        }
      }
      if (matchingKeys.size === 1) {
        return { value: matchingKeys.values().next().value as string, source: "runtime" };
      }
      if (matchingKeys.size > 1) {
        // A cloned model without its binding token is ambiguous when several
        // provider groups expose the same model ID. Never fall back to a
        // legacy key that could belong to a different provider group.
        return undefined;
      }
    }

    // Compatibility for model objects supplied by older callers/tests. New
    // discovery results never include this property.
    const legacyModelKey = normalizeApiKey((model as { apiKey?: unknown }).apiKey);
    if (legacyModelKey) {
      return { value: legacyModelKey, source: "runtime" };
    }

    const legacy = normalizeApiKey(await this.secrets.get(SECRET_STORAGE_KEY));
    return legacy ? { value: legacy, source: "legacy" } : undefined;
  }

  async resolveForTool(
    options: ToolApiKeyResolutionOptions = {},
  ): Promise<ResolvedApiKey | undefined> {
    const runtimeKeys = [...new Set(this.runtimeKeysByGroup.values())];

    if (options.cacheKeyFingerprint) {
      const matchingRuntime = runtimeKeys.find(
        (apiKey) => getApiKeyFingerprint(apiKey) === options.cacheKeyFingerprint,
      );
      if (matchingRuntime) {
        return { value: matchingRuntime, source: "runtime" };
      }
      const legacy = normalizeApiKey(await this.secrets.get(SECRET_STORAGE_KEY));
      if (legacy && getApiKeyFingerprint(legacy) === options.cacheKeyFingerprint) {
        return { value: legacy, source: "legacy" };
      }
      if (!options.allowUnmatchedRuntimeKey) {
        return undefined;
      }
    }

    if (runtimeKeys.length === 1) {
      return { value: runtimeKeys[0], source: "runtime" };
    }

    if (runtimeKeys.length > 1) {
      // Without a cache-owner fingerprint there is no safe way to decide
      // which provider group supplied the cached vision model list. Falling
      // back to an unrelated legacy key could send the request with the wrong
      // account, so ambiguous runtime ownership must fail closed.
      return undefined;
    }

    const legacy = normalizeApiKey(await this.secrets.get(SECRET_STORAGE_KEY));
    return legacy ? { value: legacy, source: "legacy" } : undefined;
  }

  async resolveLegacy(): Promise<string | undefined> {
    return normalizeApiKey(await this.secrets.get(SECRET_STORAGE_KEY));
  }

  clearRuntimeBindings(groupId?: string): void {
    if (groupId === undefined) {
      this.modelBindings = new WeakMap<object, RuntimeModelBinding>();
      this.runtimeKeysByGroup.clear();
      this.runtimeKeysByBinding.clear();
      this.bindingGroups.clear();
      this.bindingsByGroup.clear();
      this.bindingsByModelId.clear();
      return;
    }

    this.runtimeKeysByGroup.delete(groupId);
    const bindingIds = this.bindingsByGroup.get(groupId);
    if (!bindingIds) {
      return;
    }

    for (const bindingId of bindingIds) {
      this.runtimeKeysByBinding.delete(bindingId);
      this.bindingGroups.delete(bindingId);
      for (const [modelId, modelBindings] of this.bindingsByModelId) {
        modelBindings.delete(bindingId);
        if (modelBindings.size === 0) {
          this.bindingsByModelId.delete(modelId);
        }
      }
    }
    this.bindingsByGroup.delete(groupId);
  }

  private resolveBindingKey(bindingId: string | undefined): string | undefined {
    if (!bindingId) {
      return undefined;
    }
    const groupId = this.bindingGroups.get(bindingId);
    const key = this.runtimeKeysByBinding.get(bindingId);
    return groupId && key && this.runtimeKeysByGroup.get(groupId) === key ? key : undefined;
  }

  private getSerializedBindingId(model: object): string | undefined {
    const value = (model as Record<string, unknown>)[MODEL_KEY_BINDING_PROPERTY];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private getModelId(model: object): string | undefined {
    const id = (model as { id?: unknown }).id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  }

  private getOrCreateSet(map: Map<string, Set<string>>, key: string): Set<string> {
    const existing = map.get(key);
    if (existing) {
      return existing;
    }
    const created = new Set<string>();
    map.set(key, created);
    return created;
  }
}
