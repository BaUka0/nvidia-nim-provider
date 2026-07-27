import packageJson from "../../package.json";

export const PROVIDER_VENDOR = "nvidia-nim";
export const PROVIDER_DISPLAY_NAME = "NVIDIA NIM";
export const SECRET_STORAGE_KEY = "nvidia-nim.apiKey";
export const RAW_MODELS_STATE_KEY = "nvidia-nim.rawModels";
export const MODELS_STATE_KEY = "nvidia-nim.models";
export const MODELS_CACHE_VERSION_STATE_KEY = "nvidia-nim.modelsCacheVersion";
export const MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY = "nvidia-nim.modelsCacheKeyFingerprint";
export const MODELS_CACHE_VERSION = 8;
export const MIGRATION_DONE_KEY = "nvidia-nim.legacyMigrationDone";
export const DEBUG_STATE_KEY = "nvidia-nim.debug";
export const DEBUG_ENV_VAR = "NVIDIA_NIM_DEBUG";
export const MANAGE_COMMAND_ID = "nvidia-nim.manage";
export const REFRESH_MODELS_COMMAND_ID = "nvidia-nim.refreshModels";
export const TOGGLE_DEBUG_LOGGING_COMMAND_ID = "nvidia-nim.toggleDebugLogging";
export const OPEN_DEBUG_LOG_COMMAND_ID = "nvidia-nim.openDebugLog";
export const TOGGLE_SHOW_REASONING_COMMAND_ID = "nvidia-nim.toggleShowReasoning";

export const BASE_URL = "https://integrate.api.nvidia.com/v1";
export const EXTENSION_VERSION: string = packageJson.version;

/**
 * Calculate a dynamic safety margin that scales with context window size.
 * Small windows get a fixed 4096-token margin; large windows (≥256K) get 1%
 * of the window to account for estimation variance and hidden prompt content.
 */
export function calculateSafetyMargin(contextWindow: number): number {
  if (contextWindow >= 256_000) {
    return Math.max(4096, Math.ceil(contextWindow * 0.01));
  }
  return 4096;
}

/** Legacy fixed safety margin kept for backward-compatible call sites. */
export const CONTEXT_WINDOW_SAFETY_MARGIN = 4096;

/** Default token limit if model info is unknown */
export const DEFAULT_MAX_OUTPUT_TOKENS = 65536;

/** Maximum retry delay in milliseconds */
export const MAX_RETRY_DELAY_MS = 30000;

/** Base retry delay in milliseconds */
export const BASE_RETRY_DELAY_MS = 1000;

/** Maximum time (ms) between stream chunks before timeout */
export const STREAM_IDLE_TIMEOUT_MS = 120000;

export const STREAM_IDLE_TIMEOUT_MIN_MS = 60000;
export const STREAM_IDLE_TIMEOUT_MAX_MS = 300000;

export const STATUS_BAR_DEFAULT_TEXT = `$(loading~spin) NVIDIA NIM`;
export const STATUS_BAR_ERROR_TEXT = `$(zap) NVIDIA NIM`;
