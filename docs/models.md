# Model Guide & Reasoning

Overview of curated NVIDIA NIM models, capability matrix, model characteristics, and thinking blocks.

---

## Model Comparison Matrix

| Model | Picker Name | Intelligence Index | Context Limit | Max Output | Reasoning Modes | Vision | Notes |
| :--- | :--- | :---: | :---: | :---: | :--- | :---: | :--- |
| **GLM 5.3** | `GLM 5.3` | **45** | 1,048,576 | 65,536 | `Low`, `High`, `Max` | No | Flagship reasoning model, complex agentic coding, deep problem solving |
| **Kimi K3** | `Kimi K3` | **44** | 1,048,576 | 65,536 | `Low`, `High`, `Max` | Yes | Long-context reasoning, multimodal docs, agentic research |
| **GLM 5.3 Flash** | `GLM 5.3 Flash` | **42** | 1,048,576 | 131,072 | `Low`, `High`, `Max` | Yes | Fast multimodal reasoning, code generation, instant response in `Low` |
| **DeepSeek V4.1 Flash** | `DeepSeek V4.1 Flash` | **39** | 1,048,576 | 262,144 | `None`, `Low`, `High`, `Max` | Yes | Hard algorithmic work, multimodal coding, complex refactors |
| **Nemotron 3 Ultra 550B** | `Nemotron 3 Ultra 550B` | **23** | 1,000,000 | 32,768 | `None`, `Medium`, `High` | No | Heavy multi-step reasoning, system design, enterprise docs |
| **Muse Glimmer** | `Muse Glimmer` | **17** | 131,072 | 32,768 | `None` to `Max` | Yes | Front-end UI work, visual UX analysis; default vision fallback |
| **Nemotron 3.5 Lightning 30B** | `Nemotron 3.5 Lightning 30B` | **13** | 1,000,000 | 32,768 | `None`, `Medium`, `High`, `XHigh` | No | Fast agentic turns; default text fallback and summarizer |
| **Nemotron 3 Super 120B** | `Nemotron 3 Super 120B` | **13** | 1,000,000 | 32,768 | `None`, `Low`, `High` | No | Workhorse for everyday coding |

Intelligence Index values are from the Artificial Analysis Intelligence Index (v4.3.2 verified; see `CHANGELOG.md`).

---

## Per-Model Notes

**GLM 5.3.** Flagship open-weights reasoning model with 1M context, up to 65,536 output tokens. Strong on multi-step reasoning, system architecture, and agentic workflows. Reasoning: `Low` (instant answer), `High`, `Max`. Text-only; vision requests fail over to `fallback.visionModel`.

**GLM 5.3 Flash.** Fast multimodal reasoning model with 1M context and up to 131,072 output tokens. Reasoning: `Low` (instant answer), `High`, `Max`.

**Nemotron 3 Super 120B.** MoE reasoning model for everyday coding, 1M context, up to 32,768 output tokens. Reasoning: `None` (standard), `Low` (quick pass), `High` (thorough). NVIDIA briefly retired it on October 3, 2026 and restored it the next day, so it is not used as a default.

**Nemotron 3.5 Lightning 30B.** Default text fallback and summarization model. Compact 30B/3B-active MoE for fast agentic turns. 1M context, up to 32,768 output tokens. Reasoning: `None`, `Medium`, `High`, `XHigh`; defaults to `Medium` because reasoning shares the answer's token budget. Text-only; vision requests fail over to `fallback.visionModel`.

**Kimi K3.** Always reasons; the effort is `Low`, `High`, or `Max`.

**Muse Glimmer.** Reasoning: `None`, `Minimal`, `Low`, `Medium`, `High`, `Max`.

**DeepSeek V4.1 Flash.** Multimodal MoE model with 1M context and up to 262,144 output tokens, NVIDIA's default for this model. Reasoning shares that budget with the answer. Strong on algorithms, debugging, schema design, SQL, and refactors. Native vision support for visual code analysis and diagrams. Reasoning: `None`, `Low`, `High`, `Max`.


---

## Reasoning (Thinking) Blocks

### Collapsible Thinking Blocks

DeepSeek V4, Nemotron Super, Kimi K3, and GLM 5.3 / GLM 5.3 Flash produce an internal stream of logical thought before the final answer. The extension filters `<thought>`, `<think>`, and `[THINK]` tags and renders them via VS Code's `LanguageModelThinkingPart`. In Copilot Chat you see a collapsible **Thinking...** bar; click to expand and read the step-by-step reasoning, or leave it collapsed to focus on the response.

### Controlling Reasoning Effort

Reasoning is on by default: `High` for every model except Nemotron 3.5 Lightning, which uses `Medium`. You can change it in two ways:

1. Per model: choose **Reasoning Mode** next to the model in the Copilot model picker. This choice wins over the setting.
2. As the default for all models: `nvidia-nim.reasoning.mode` in the VS Code Settings UI or `settings.json`. It becomes the preselected Reasoning Mode in the picker. A model without that mode uses its closest one, and once you set it, it applies to Lightning too.

Summaries of long conversations and image analysis always run with reasoning off, so their short replies are not used up by thinking.

