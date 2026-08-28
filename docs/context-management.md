# Long Context Management & Auto-Compaction

Mechanisms for maintaining long multi-turn sessions without context overflow.

---

## Why Context Windows Overflow

In long sessions, chat history, system instructions, and file contents accumulate. When the total approaches the model's context limit, requests fail with `HTTP 400 Context Window Exceeded`.

---

## Decoupled Background Summarization

When conversation length approaches capacity, the extension compacts older turns into a dense summary. Compaction runs through a dedicated model (`nvidia-nim.context.summarizationModel`, default `Nemotron 3 Super 120B`), so your active primary model is never disturbed.

---

## Safety Margin Buffer

Tokenizers (BPE and similar) can produce slightly different token counts on the client vs. the server. The extension reserves a configurable safety margin (default `1.0%` of the context window, via `nvidia-nim.context.safetyMarginPercent`) to prevent off-by-one overflow errors.
