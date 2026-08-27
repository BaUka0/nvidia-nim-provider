/** NVIDIA NIM keys issued at build.nvidia.com look like `nvapi-` plus a token. */
const NIM_API_KEY_PATTERN = /^nvapi-[A-Za-z0-9_-]{16,}$/;

export function isLikelyNvidiaApiKey(value: string): boolean {
  return NIM_API_KEY_PATTERN.test(value.trim());
}
