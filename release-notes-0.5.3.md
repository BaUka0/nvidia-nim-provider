# v0.5.3

## A quieter, tighter build

This is a maintenance release. Chat, tools, overflow recovery, and vision behave the same as in 0.5.2 — the work is under the hood so the next features sit on cleaner code.

## What we cleaned up

- **Dead paths are gone.** Unused helpers for stripping think tags, the old status-bar usage line, and a per-model limit reset that nothing called have been removed. The live status bar still uses the token breakdown you already see.
- **Adapters fail safer.** If a model adapter is not ready yet, the extension now falls back to the shared tool-call parser instead of crashing on a forced unwrap.
- **Stricter types in CI.** Explicit `any` is now a lint error, and tests build their VS Code doubles through shared factories instead of one-off casts. That makes regressions harder to sneak in.

## Under the hood

- TypeScript now targets ES2022, which matches current VS Code.
- The compiled extension is smaller and easier to follow. Lint, typecheck, and 484 automated tests are green.

## Install

Download the `nvidia-nim-agent-0.5.3.vsix` file and install it from the VS Code Extensions view using **Install from VSIX...**
