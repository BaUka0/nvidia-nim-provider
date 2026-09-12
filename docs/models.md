# Model Guide & Reasoning

Overview of curated NVIDIA NIM models, capability matrix, model characteristics, and thinking blocks.

---

## Model Comparison Matrix

| Model | Picker Name | Intelligence Index | Context Limit | Max Output | Reasoning Modes | Vision | Notes |
| :--- | :--- | :---: | :---: | :---: | :--- | :---: | :--- |
| **Kimi K3** | `Kimi K3` | **44** | 1,048,576 | 65,536 | `None`, `Low`, `High`, `Max` | Yes | Long-context reasoning, multimodal docs, agentic research |
| **GLM 5.3 Flash** | `GLM 5.3 Flash` | **42** | 1,048,576 | 131,072 | `Low`, `High`, `Max` | Yes | Fast multimodal reasoning, code generation, instant response in `Low` |
| **DeepSeek V4 Pro 0813** | `DeepSeek V4 Pro 0813` | **36** | 1,048,576 | 131,072 | `None`, `High`, `Max` | No | High-capacity reasoning, large code generation, deep problem solving |
| **DeepSeek V4 Flash 0731** | `DeepSeek V4 Flash 0731` | **35** | 1,048,576 | 131,072 | `None`, `High`, `Max` | No | Hard algorithmic work, complex refactors, deep math |
| **Nemotron 3 Ultra 550B** | `Nemotron 3 Ultra 550B` | **23** | 1,000,000 | 65,536 | `None`, `Medium`, `High` | No | Heavy multi-step reasoning, system design, enterprise docs |
| **Muse Glimmer** | `Muse Glimmer` | **18** | 131,072 | 32,768 | `None` to `XHigh` | Yes | Front-end UI work, visual UX analysis; default vision fallback |
| **Nemotron 3 Super 120B** | `Nemotron 3 Super 120B` | **14** | 1,000,000 | 65,536 | `None`, `Low`, `High` | No | Workhorse for everyday coding; default text fallback and summarizer |
| **Nemotron 3.5 Lightning 30B** | `Nemotron 3.5 Lightning 30B` | **14** | 1,000,000 | 32,768 | `None`, `Medium`, `High`, `XHigh` | No | Fast agentic turns; compact 30B/3B-active MoE |

Intelligence Index values are from the Artificial Analysis Intelligence Index (v4.3 verified; see `CHANGELOG.md`).

---

## Per-Model Notes

**Nemotron 3 Super 120B.** Default text fallback and summarization model. MoE reasoning, 1M context, up to 65,536 output tokens. Reasoning: `None` (standard), `Low` (quick pass), `High` (thorough).

**Nemotron 3.5 Lightning 30B.** Compact 30B/3B-active MoE for fast agentic turns. 1M context, up to 32,768 output tokens. Reasoning: `None`, `Medium`, `High`, `XHigh`. Text-only; vision requests fail over to `fallback.visionModel`.

**DeepSeek V4 Flash 0731.** Strong on algorithms, debugging, schema design, SQL, and refactors. Reasoning: `None`, `High`, `Max`.


---

## Reasoning (Thinking) Blocks

### Collapsible Thinking Blocks

DeepSeek V4, Nemotron Super, Kimi K3, and GLM 5.3 Flash produce an internal stream of logical thought before the final answer. The extension filters `<thought>`, `<think>`, and `[THINK]` tags and renders them via VS Code's `LanguageModelThinkingPart`. In Copilot Chat you see a collapsible **Thinking...** bar; click to expand and read the step-by-step reasoning, or leave it collapsed to focus on the response.

### Controlling Reasoning Effort

You can set the effort in two ways:

1. Per turn in chat: pick the model with your preferred mode from the Copilot model dropdown (e.g. `DeepSeek V4 Flash 0731 (High)`).
2. Globally via settings: `"nvidia-nim.reasoning.mode": "high"` in `settings.json`.

If you want thinking to render as visible text instead of a collapsible block, set `"nvidia-nim.reasoning.showInChat": true`.
