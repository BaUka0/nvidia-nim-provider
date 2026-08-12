# v0.5.1

## Say hello to Muse Glimmer

This release adds **Muse Glimmer** (`meta/muse-glimmer-30b`) to the curated model lineup — a ~30B multimodal reasoning model distilled from Muse Spark and built specifically for autonomous agentic work:

- **Vision input.** Send screenshots, charts, documents, and images alongside your text — Muse Glimmer reasons over all of them.
- **Tool calling.** Full native function-calling support for Agent mode workflows.
- **Fine-grained reasoning control.** Pick the thinking budget per task with five reasoning efforts: **None, Low, Medium, High, XHigh** — from instant answers to deep multi-step reasoning.
- **131,072-token context window** with a 32,768-token output budget.

Strong benchmark results across agentic coding (76.0 SWE-Bench Verified), multimodal understanding, and general reasoning make it one of the best sub-100B options in the catalog.

## Laguna XS 2.1 removed

We hold every curated model to a high bar, and Laguna XS 2.1 no longer cleared it. At roughly the same parameter count, Muse Glimmer is stronger across the board, so Laguna has been retired to keep the lineup lean and worth your time. If you had it selected, pick any other model from the catalog.

## Install

Download the `nvidia-nim-agent-0.5.1.vsix` file and install it from the VS Code Extensions view using **Install from VSIX...**
