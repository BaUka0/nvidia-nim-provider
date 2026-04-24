// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require("../package.json") as { version: string };

export const PROVIDER_VENDOR = "nvidia-nim";
export const PROVIDER_DISPLAY_NAME = "NVIDIA NIM";
export const SECRET_STORAGE_KEY = "nvidia-nim.apiKey";
export const MODELS_STATE_KEY = "nvidia-nim.models";
export const DEBUG_STATE_KEY = "nvidia-nim.debug";
export const DEBUG_ENV_VAR = "NVIDIA_NIM_DEBUG";
export const MANAGE_COMMAND_ID = "nvidia-nim.manage";
export const REFRESH_MODELS_COMMAND_ID = "nvidia-nim.refreshModels";
export const TOGGLE_DEBUG_LOGGING_COMMAND_ID = "nvidia-nim.toggleDebugLogging";
export const OPEN_DEBUG_LOG_COMMAND_ID = "nvidia-nim.openDebugLog";

export const BASE_URL = "https://integrate.api.nvidia.com/v1";
export const EXTENSION_VERSION: string = pkg.version;

/** Safety margin for context window calculations (in tokens) */
export const CONTEXT_WINDOW_SAFETY_MARGIN = 4096;

/** Default token limit if model info is unknown */
export const DEFAULT_MAX_OUTPUT_TOKENS = 65536;

/** Maximum retry delay in milliseconds */
export const MAX_RETRY_DELAY_MS = 30000;

/** Base retry delay in milliseconds */
export const BASE_RETRY_DELAY_MS = 1000;

/** Max tool result characters for Anthropic API */
export const ANTHROPIC_MAX_TOOL_RESULT_CHARS = 20000;

/** Models that require the reasoning_content workaround */
export const REASONING_CONTENT_WORKAROUND_MODELS = new Set(["kimi-k2.5", "kimi-k2.6"]);
