const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";
const CURATED_MODEL_IDS = new Set([
  "deepseek-ai/deepseek-v4-flash-0731",
  "minimaxai/minimax-m3",
  "moonshotai/kimi-k3",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "stepfun-ai/step-3.7-flash",
  "thinkingmachines/inkling",
  "meta/muse-glimmer-30b",
]);

const baseUrl = (process.env.NVIDIA_NIM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
const response = await fetch(`${baseUrl}/models`, {
  headers: { Accept: "application/json" },
});
const text = await response.text();

if (!response.ok) {
  throw new Error(`GET ${baseUrl}/models failed with HTTP ${response.status}: ${text}`);
}

const payload = JSON.parse(text);
const models = Array.isArray(payload?.data) ? payload.data : [];
const selectedModels = process.argv.includes("--all")
  ? models
  : models.filter((model) => CURATED_MODEL_IDS.has(model?.id));

console.log(JSON.stringify({ object: payload?.object, data: selectedModels }, null, 2));

const identityFields = new Set(["id", "object", "created", "owned_by"]);
const metadataFields = new Set(
  selectedModels.flatMap((model) =>
    Object.keys(model || {}).filter((key) => !identityFields.has(key)),
  ),
);

if (metadataFields.size === 0) {
  console.error(
    "NVIDIA /v1/models returned no context-window metadata; use the context probe scripts for runtime verification.",
  );
} else {
  console.error(`Additional model metadata fields: ${[...metadataFields].sort().join(", ")}`);
}
