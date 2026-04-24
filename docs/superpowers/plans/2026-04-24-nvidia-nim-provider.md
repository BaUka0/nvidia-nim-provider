# NVIDIA NIM Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone VS Code Copilot Chat extension in `nvidia-nim-provider` that discovers NVIDIA-hosted NIM models dynamically and sends chat requests to `https://integrate.api.nvidia.com/v1`.

**Architecture:** Start from the proven `opencode-go-provider` extension shape, then rebrand and simplify it into a NVIDIA-only OpenAI-compatible provider. Keep model normalization in `src/model-catalog.ts`, keep HTTP and SSE logic in `src/api.ts`, and keep VS Code request translation in `src/provider.ts`.

**Tech Stack:** TypeScript, VS Code Language Model API, bun, Jest, ESLint, Prettier

**Implementation Skills:** @test-driven-development, @verification-before-completion, @typescript-standards

---

## File Map

| Path | Action | Responsibility |
| --- | --- | --- |
| `package.json` | Create from reference, then modify | Extension metadata, commands, scripts, chat provider contribution |
| `README.md` | Create from reference, then modify | User setup and development guide for NVIDIA NIM |
| `bun.lock` | Create from reference | Lockfile for bun-managed dependencies |
| `bunfig.toml` | Create from reference, then verify | bun install configuration |
| `tsconfig.json` | Create from reference | TypeScript compile settings |
| `jest.config.js` | Create from reference | Jest configuration |
| `eslint.config.mjs` | Create from reference | Lint configuration |
| `.gitignore` | Create from reference, then modify if needed | Ignore build outputs and local artifacts |
| `.vscodeignore` | Create from reference | VSIX packaging exclusions |
| `.prettierrc` | Create from reference | Formatting configuration |
| `images/icon.png` | Create from reference | Extension icon |
| `src/constants.ts` | Create from reference, then modify | Base URL, extension version, provider constants |
| `src/types.ts` | Create from reference, then modify | NVIDIA `/models` response types and OpenAI-compatible request types |
| `src/api.ts` | Create from reference, then modify | `/models` fetch, `/chat/completions` streaming, retry logic |
| `src/model-catalog.ts` | Create | Normalize raw NVIDIA models into VS Code model metadata |
| `src/provider.ts` | Create from reference, then modify | API key enforcement, request conversion, capability gating, stream handling |
| `src/extension.ts` | Create from reference, then modify | Provider registration, commands, refresh wiring, secret storage integration |
| `src/output-channel.ts` | Create from reference | Extension logging |
| `src/tools.ts` | Create from reference | Tool registration passthrough |
| `src/utils.ts` | Create from reference, then trim if needed | Shared request/response helpers |
| `src/mcp.ts` | Do not copy | NVIDIA v1 does not use MCP image fallback |
| `tests/api.test.ts` | Create from reference, then modify | API client and SSE behavior |
| `tests/model-catalog.test.ts` | Create | Model normalization and capability inference |
| `tests/provider.test.ts` | Create from reference, then modify | Provider behavior, tool calling, image handling, missing-key guidance |
| `tests/extension.test.ts` | Create from reference, then modify | Activation and refresh flow |
| `tests/tools.test.ts` | Create from reference | Tool registration tests |
| `tests/utils.test.ts` | Create from reference, then modify if needed | Shared helper tests that still apply |
| `tests/mcp.test.ts` | Do not copy | Removed with MCP integration |
| `docs/superpowers/specs/2026-04-24-nvidia-nim-provider-design.md` | Keep | Approved source specification |

## Task 1: Scaffold the project from the reference extension

**Files:**
- Create: `package.json`
- Create: `README.md`
- Create: `bun.lock`
- Create: `bunfig.toml`
- Create: `tsconfig.json`
- Create: `jest.config.js`
- Create: `eslint.config.mjs`
- Create: `.gitignore`
- Create: `.vscodeignore`
- Create: `.prettierrc`
- Create: `images/icon.png`
- Create: `src/constants.ts`
- Create: `src/output-channel.ts`
- Create: `src/tools.ts`
- Create: `src/utils.ts`
- Create: `tests/api.test.ts`
- Create: `tests/extension.test.ts`
- Create: `tests/provider.test.ts`
- Create: `tests/tools.test.ts`
- Create: `tests/utils.test.ts`

- [ ] **Step 1: Copy only the source and config files from the reference project**

Run:

```bash
rsync -av \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'out' \
  --exclude '*.vsix' \
  --exclude 'package-lock.json' \
  /Users/hidenobunagai/Projects/opencode-go-provider/ \
  /Users/hidenobunagai/Projects/nvidia-nim-provider/
```

Expected: the new project contains config files, `src/`, `tests/`, `images/`, and docs, but no build output or Node install artifacts.

- [ ] **Step 2: Remove files that the NVIDIA version must not keep**

Run:

```bash
cd /Users/hidenobunagai/Projects/nvidia-nim-provider && rm -f src/mcp.ts tests/mcp.test.ts package-lock.json
```

Expected: no MCP-only files remain in the NVIDIA project.

- [ ] **Step 3: Install dependencies safely**

Run:

```bash
cd /Users/hidenobunagai/Projects/nvidia-nim-provider && bun install --ignore-scripts
```

Expected: bun finishes successfully and preserves the project as a bun-managed workspace.

- [ ] **Step 4: Run the baseline compile before changing behavior**

Run:

```bash
cd /Users/hidenobunagai/Projects/nvidia-nim-provider && bun run compile
```

Expected: PASS. This confirms the copied reference project still builds before the NVIDIA-specific edits begin.

- [ ] **Step 5: Commit the scaffold**

Run:

```bash
cd /Users/hidenobunagai/Projects/nvidia-nim-provider && \
git add . && \
git commit -m "chore: scaffold NVIDIA provider from reference" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 2: Rebrand the extension metadata and command surface

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `src/extension.ts`
- Modify: `src/constants.ts`
- Test: `tests/extension.test.ts`

- [ ] **Step 1: Write the failing extension metadata test**

Add assertions like:

```ts
expect(vscode.lm.registerLanguageModelChatProvider).toHaveBeenCalledWith(
  "nvidia-nim",
  expect.anything(),
);
expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
  "nvidia-nim.manage",
  expect.any(Function),
);
```

- [ ] **Step 2: Run the targeted test to verify the old OpenCode names fail**

Run:

```bash
cd /Users/hidenobunagai/Projects/nvidia-nim-provider && bun run test -- --runInBand tests/extension.test.ts
```

Expected: FAIL because the copied project still registers `opencode-go` identifiers and labels.

- [ ] **Step 3: Update the extension metadata and command names**

Apply these exact direction changes:

```json
{
  "name": "nvidia-nim-provider",
  "displayName": "NVIDIA NIM Provider",
  "contributes": {
    "languageModelChatProviders": [
      {
        "vendor": "nvidia-nim",
        "displayName": "NVIDIA NIM",
        "managementCommand": "nvidia-nim.manage"
      }
    ]
  }
}
```

Also rename all secret keys, command IDs, user-agent strings, and visible messages in `src/extension.ts` and `README.md` from `opencode-go` / `OpenCode Go` to `nvidia-nim` / `NVIDIA NIM`.

- [ ] **Step 4: Run the targeted test again**

Run:

```bash
cd /Users/hidenobunagai/Projects/nvidia-nim-provider && bun run test -- --runInBand tests/extension.test.ts
```

Expected: PASS for the renamed provider registration and command surface.

- [ ] **Step 5: Commit the metadata rebrand**

Run:

```bash
cd /Users/hidenobunagai/Projects/nvidia-nim-provider && \
git add package.json README.md src/constants.ts src/extension.ts tests/extension.test.ts && \
git commit -m "feat: rebrand extension for NVIDIA NIM" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 3: Implement model normalization for dynamic `/models`

**Files:**
- Create: `src/model-catalog.ts`
- Modify: `src/types.ts`
- Test: `tests/model-catalog.test.ts`

- [ ] **Step 1: Write the failing normalization tests**

Add cases like:

```ts
const raw = [
  {
    id: "meta/llama-4-maverick-17b-128e-instruct",
    capabilities: { chat: true, vision: true, tool_calling: true },
    metadata: { context_window: 128000 }
  },
  {
    id: "nvidia/nv-embedqa-e5-v5",
    capabilities: { chat: false }
  }
];

expect(normalizeNvidiaModels(raw)).toEqual([
  expect.objectContaining({
    id: "meta/llama-4-maverick-17b-128e-instruct",
    supportsVision: true,
    supportsTools: true
  })
]);
```

- [ ] **Step 2: Run the new test file and verify it fails**

Run:

```bash
cd /Users/hidenobunagai/Projects/nvidia-nim-provider && bun run test -- --runInBand tests/model-catalog.test.ts
```

Expected: FAIL because `src/model-catalog.ts` does not exist yet.

- [ ] **Step 3: Implement the model catalog and raw model types**

Create `src/model-catalog.ts` with focused exports:

```ts
export interface NormalizedNvidiaModel {
  id: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
}

export function normalizeNvidiaModels(models: NvidiaModelSummary[]): NormalizedNvidiaModel[] {
  // Prefer API metadata, then KNOWN_MODEL_OVERRIDES, then safe defaults.
}
```

Add the `/models` response types to `src/types.ts`, including capability and metadata fields used by the normalizer.

- [ ] **Step 4: Run the normalization tests again**

Run:

```bash
cd /Users/hidenobunagai/Projects/nvidia-nim-provider && bun run test -- --runInBand tests/model-catalog.test.ts
```

Expected: PASS for capability inference, safe defaults, and non-chat model filtering.

- [ ] **Step 5: Commit the model catalog**

Run:

```bash
cd /Users/hidenobunagai/Projects/nvidia-nim-provider && \
git add src/model-catalog.ts src/types.ts tests/model-catalog.test.ts && \
git commit -m "feat: normalize NVIDIA model metadata" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 4: Replace the HTTP client with NVIDIA `/models` and `/chat/completions`

**Files:**
- Modify: `src/constants.ts`
- Modify: `src/types.ts`
- Modify: `src/api.ts`
- Test: `tests/api.test.ts`

- [ ] **Step 1: Write the failing API tests**

Cover these behaviors:

```ts
await expect(fetchModels("test-key")).resolves.toEqual([
  expect.objectContaining({ id: "meta/llama-4-maverick-17b-128e-instruct" })
]);

await expect(gen.next()).rejects.toThrow("NVIDIA NIM API error: 500 Internal Server Error");
expect(fetch).toHaveBeenCalledWith(
  "https://integrate.api.nvidia.com/v1/models",
  expect.objectContaining({
    headers: expect.objectContaining({ Authorization: "Bearer test-key" })
  })
);
```

- [ ] **Step 2: Run the API tests to verify they fail against the copied OpenCode URL**

Run:

```bash
cd /Users/hidenobunagai/Projects/nvidia-nim-provider && bun run test -- --runInBand tests/api.test.ts
```

Expected: FAIL because the copied client still points at the OpenCode base URL and response shape.

- [ ] **Step 3: Implement the NVIDIA API client**

Make these changes:

```ts
export const BASE_URL = "https://integrate.api.nvidia.com/v1";
```

Keep the existing retry strategy, but update `fetchModels()` to parse the NVIDIA `/models` payload and update `streamChatCompletion()` error messages to mention `NVIDIA NIM`.

- [ ] **Step 4: Run the API tests again**

Run:

```bash
cd /Users/hidenobunagai/Projects/nvidia-nim-provider && bun run test -- --runInBand tests/api.test.ts
```

Expected: PASS for `/models`, SSE parsing, auth failures, and retry behavior.

- [ ] **Step 5: Commit the NVIDIA API client**

Run:

```bash
cd /Users/hidenobunagai/Projects/nvidia-nim-provider && \
git add src/constants.ts src/types.ts src/api.ts tests/api.test.ts && \
git commit -m "feat: add NVIDIA NIM API client" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 5: Simplify the provider to the NVIDIA-only request path

**Files:**
- Modify: `src/provider.ts`
- Modify: `src/utils.ts`
- Modify: `src/tools.ts`
- Test: `tests/provider.test.ts`
- Test: `tests/utils.test.ts`

- [ ] **Step 1: Write the failing provider tests**

Add assertions for three behaviors:

```ts
expect(streamChatCompletion).toHaveBeenCalledWith(
  "test-key",
  expect.objectContaining({
    model: "meta/llama-4-maverick-17b-128e-instruct",
    tools: expect.any(Array)
  }),
  expect.any(AbortSignal),
  "test-ua",
);

expect(progress.report).toHaveBeenCalledWith(
  expect.objectContaining({ value: expect.stringContaining("does not support image input") })
);
```

Also add one test that verifies a vision-capable model converts a VS Code image part into:

```ts
{
  type: "image_url",
  image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) }
}
```

- [ ] **Step 2: Run the provider-focused tests and confirm they fail**

Run:

```bash
cd /Users/hidenobunagai/Projects/nvidia-nim-provider && bun run test -- --runInBand tests/provider.test.ts tests/utils.test.ts
```

Expected: FAIL because the copied provider still contains OpenCode-specific branches and MCP fallback logic.

- [ ] **Step 3: Implement the minimal NVIDIA-only provider path**

Refactor toward these boundaries:

```ts
const normalizedModels = this.globalState?.get<NormalizedNvidiaModel[]>("nvidia-nim.models") ?? [];
const modelInfo = normalizedModels.find((entry) => entry.id === model.id);

if (hasImages && !modelInfo?.supportsVision) {
  progress.report(new vscode.LanguageModelTextPart("The selected NVIDIA NIM model does not support image input."));
  return;
}
```

Requirements:
- remove Anthropic-specific branching
- remove MCP image fallback code
- use normalized catalog entries for tool and image capability gating
- keep OpenAI-compatible tool-call streaming behavior
- convert image parts to `image_url` content only for vision-capable models

- [ ] **Step 4: Run the provider-focused tests again**

Run:

```bash
cd /Users/hidenobunagai/Projects/nvidia-nim-provider && bun run test -- --runInBand tests/provider.test.ts tests/utils.test.ts
```

Expected: PASS for missing-key guidance, tool calling, image gating, image conversion, and streaming output.

- [ ] **Step 5: Commit the provider simplification**

Run:

```bash
cd /Users/hidenobunagai/Projects/nvidia-nim-provider && \
git add src/provider.ts src/utils.ts src/tools.ts tests/provider.test.ts tests/utils.test.ts && \
git commit -m "feat: simplify provider for NVIDIA chat completions" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 6: Wire activation, caching, and refresh around the normalized catalog

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/provider.ts`
- Test: `tests/extension.test.ts`

- [ ] **Step 1: Write the failing activation and refresh tests**

Add cases like:

```ts
expect(globalState.update).toHaveBeenCalledWith(
  "nvidia-nim.rawModels",
  expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]),
);
expect(globalState.update).toHaveBeenCalledWith(
  "nvidia-nim.models",
  expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]),
);
expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
  expect.stringContaining("NVIDIA NIM"),
);
```

Also add a failure-path case where `/models` refresh fails after a previous successful cache exists, and assert that:

```ts
expect(globalState.update).not.toHaveBeenCalledWith("nvidia-nim.models", []);
expect(provider.provideLanguageModelChatInformation({ silent: true } as any, token as any)).resolves.toEqual(
  expect.arrayContaining([expect.objectContaining({ id: "cached-model" })]),
);
```

- [ ] **Step 2: Run the extension tests to verify they fail**

Run:

```bash
cd /Users/hidenobunagai/Projects/nvidia-nim-provider && bun run test -- --runInBand tests/extension.test.ts
```

Expected: FAIL because the copied extension still stores OpenCode cache keys and messages.

- [ ] **Step 3: Implement the refresh and cache wiring**

Make sure:
- the extension stores raw models under `nvidia-nim.rawModels`
- the extension stores normalized models under `nvidia-nim.models`
- refresh commands use the NVIDIA API key secret
- activation triggers a background refresh when a key exists
- refresh failures leave both existing raw and normalized caches untouched
- the provider reads the normalized cache without blocking the picker

- [ ] **Step 4: Run the extension tests again**

Run:

```bash
cd /Users/hidenobunagai/Projects/nvidia-nim-provider && bun run test -- --runInBand tests/extension.test.ts
```

Expected: PASS for registration, secret changes, refresh caching, and user-visible messages.

- [ ] **Step 5: Commit the refresh wiring**

Run:

```bash
cd /Users/hidenobunagai/Projects/nvidia-nim-provider && \
git add src/extension.ts src/provider.ts tests/extension.test.ts && \
git commit -m "feat: wire NVIDIA model refresh and caching" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 7: Finalize docs and run full verification

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `tests/provider.test.ts`

- [ ] **Step 1: Update the user-facing documentation**

Ensure `README.md` includes:

```md
## Setup

1. Run `NVIDIA NIM: Manage NVIDIA API Key`.
2. Paste the key obtained from https://build.nvidia.com/models.
3. Use the `NVIDIA NIM` provider in Copilot Chat.
```

Also confirm `package.json` keywords and descriptions mention NVIDIA NIM instead of OpenCode Go.

- [ ] **Step 2: Add the final API coverage for image-capable request shaping**

Extend `tests/provider.test.ts` so the suite explicitly covers the v1 image input contract for
vision-capable models and the user-facing rejection path for non-vision models.

- [ ] **Step 3: Run the full project checks**

Run:

```bash
cd /Users/hidenobunagai/Projects/nvidia-nim-provider && \
bun run lint && \
bun run test -- --runInBand && \
bun run compile && \
bun run package:vsix
```

Expected: PASS for lint, tests, compile, and VSIX packaging. A `.vsix` file should be generated in the project root.

- [ ] **Step 4: Inspect the final git state**

Run:

```bash
cd /Users/hidenobunagai/Projects/nvidia-nim-provider && git --no-pager status --short
```

Expected: only the intended doc, source, test, and packaging changes remain.

- [ ] **Step 5: Commit the final docs and verified build**

Run:

```bash
cd /Users/hidenobunagai/Projects/nvidia-nim-provider && \
git add README.md package.json tests/provider.test.ts . && \
git commit -m "docs: finalize NVIDIA NIM provider setup" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
