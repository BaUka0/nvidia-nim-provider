# Model Guide & Reasoning

Overview of curated NVIDIA NIM models, capability matrix, model characteristics, and thinking blocks.

---

## Model Comparison Matrix

| Model | Picker Name | Intelligence Index | Context Limit | Max Output | Reasoning Modes | Vision | Notes |
| :--- | :--- | :---: | :---: | :---: | :--- | :---: | :--- |
| **Kimi K3** | `Kimi K3` | **60** | 1,048,576 | 65,536 | `None`, `Low`, `High`, `Max` | Yes | Long-context reasoning, multimodal docs, agentic research |
| **DeepSeek V4 Pro 0813** | `DeepSeek V4 Pro 0813` | **53** | 1,048,576 | 131,072 | `None`, `High`, `Max` | No | High-capacity reasoning, large code generation, deep problem solving |
| **DeepSeek V4 Flash 0731** | `DeepSeek V4 Flash 0731` | **52** | 1,048,576 | 131,072 | `None`, `High`, `Max` | No | Hard algorithmic work, complex refactors, deep math |
| **MiniMax M3** | `MiniMax M3` | **45** | 1,000,000 | 100,000 | `None`, `On`, `Adaptive` | Yes | Multimodal coding, screenshot debugging, full-stack UI |
| **Nemotron 3 Ultra 550B** | `Nemotron 3 Ultra 550B` | **38** | 1,000,000 | 65,536 | `None`, `Medium`, `High` | No | Heavy multi-file reasoning, system design, enterprise docs |
| **Muse Glimmer** | `Muse Glimmer` | **35** | 131,072 | 32,768 | `None` to `XHigh` | Yes | Front-end UI work, visual UX analysis; default vision fallback |
| **Nemotron 3 Super 120B** | `Nemotron 3 Super 120B` | **26** | 1,000,000 | 65,536 | `None`, `Low`, `High` | No | Workhorse for everyday coding; default text fallback and summarizer |
| **Nemotron 3.5 Lightning 30B** | `Nemotron 3.5 Lightning 30B` | **24** | 1,000,000 | 32,768 | `None`, `Medium`, `High`, `XHigh` | No | Fast agentic turns; compact 30B/3B-active MoE |

Intelligence Index values are from the Artificial Analysis Intelligence Index (verified; see `CHANGELOG.md` 0.9.2).

---

## Per-Model Notes

**Nemotron 3 Super 120B.** Default text fallback and summarization model. MoE reasoning, 1M context, up to 65,536 output tokens. Reasoning: `None` (standard), `Low` (quick pass), `High` (thorough).

**Nemotron 3.5 Lightning 30B.** Compact 30B/3B-active MoE for fast agentic turns. 1M context, up to 32,768 output tokens. Reasoning: `None`, `Medium`, `High`, `XHigh`. Text-only; vision requests fail over to `fallback.visionModel`.

**DeepSeek V4 Flash 0731.** Strong on algorithms, debugging, schema design, SQL, and refactors. Reasoning: `None`, `High`, `Max`.

**MiniMax M3.** 1M context plus native vision. Paste a UI screenshot to generate React/Tailwind/Vue, inspect an architecture diagram, read a PDF chart, or fix a visual bug. When this model fails on a vision request, the failover default is `Muse Glimmer`; MiniMax stays in the picker.

---

## Reasoning (Thinking) Blocks

### Collapsible Thinking Blocks

DeepSeek V4, Nemotron Super, and Kimi K3 produce an internal stream of logical thought before the final answer. The extension filters `<thought>`, `<think>`, and `[THINK]` tags and renders them via VS Code's `LanguageModelThinkingPart`. In Copilot Chat you see a collapsible **Thinking...** bar; click to expand and read the step-by-step reasoning, or leave it collapsed to focus on the response.

### Controlling Reasoning Effort

You can set the effort in two ways:

1. Per turn in chat: pick the model with your preferred mode from the Copilot model dropdown (e.g. `DeepSeek V4 Flash 0731 (High)`).
2. Globally via settings: `"nvidia-nim.reasoning.mode": "high"` in `settings.json`.

If you want thinking to render as visible text instead of a collapsible block, set `"nvidia-nim.reasoning.showInChat": true`.
