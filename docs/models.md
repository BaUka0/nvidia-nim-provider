# Model Guide & Reasoning

Overview of curated NVIDIA NIM models, capability matrix, model characteristics, and thinking blocks.

---

## Model Comparison Matrix

| Model | Picker Name | Intelligence Index | Context Limit | Max Output | Reasoning Modes | Vision | Notes |
| :--- | :--- | :---: | :---: | :---: | :--- | :---: | :--- |
| **DeepSeek V4.1 Flash** | `DeepSeek V4.1 Flash` | **32** | 1,048,576 | 262,144 | `None`, `Low`, `High`, `Max` | Yes | Hard algorithmic work, multimodal coding, complex refactors |
| **MiniMax M3.1 Flash** | `MiniMax M3.1 Flash` | **29** | 262,144 | 65,536 | `Low` to `Max` | Yes | Fast multimodal MoE for agentic coding and visual input |
| **Step 5 Preview** | `Step 5 Preview` | **29** | 1,048,576 | 262,144 | Always on | Yes | StepFun preview with tools and image input |
| **Mistral Large 4** | `Mistral Large 4` | **26** | 1,048,576 | 262,144 | `Low`, `Medium`, `High` | Yes | Large multimodal MoE for agentic coding, document and image analysis |
| **Nemotron 3.5 Super VL** | `Nemotron 3.5 Super VL` | **14** | 1,048,576 | 131,072 | `None`, `Low`, `High` | Yes | Coding, tools, and image input in one model |
| **Nemotron 3 Ultra** | `Nemotron 3 Ultra` | **12** | 1,000,000 | 32,768 | `None`, `Medium`, `High` | No | Heavy multi-step reasoning, system design, enterprise docs |
| **Muse Glimmer** | `Muse Glimmer` | **6** | 131,072 | 32,768 | `None` to `Max` | Yes | Front-end UI work, visual UX analysis; default vision fallback |
| **GLM 5.3 Flash** | `GLM 5.3 Flash` | N/A | 1,048,576 | 131,072 | `Low`, `High`, `Max` | Yes | Fast multimodal reasoning, code generation, instant response in `Low` |
| **Nemotron 3.5 Lightning** | `Nemotron 3.5 Lightning` | N/A | 1,000,000 | 32,768 | `None`, `Medium`, `High`, `XHigh` | No | Fast agentic turns; default text fallback and summarizer |

Intelligence Index values are from the Artificial Analysis Intelligence Index v5.0 (checked 2026-10-30). GLM 5.3 Flash and Nemotron 3.5 Lightning have no v5 score yet.

---

## Per-Model Notes

**GLM 5.3 Flash.** Fast multimodal reasoning model with 1M context and up to 131,072 output tokens. Reasoning: `Low` (instant answer), `High`, `Max`.

**Nemotron 3.5 Super VL.** Vision-language successor to Nemotron 3 Super: 120B/12B-active MoE with image input, 1M context, and up to 131,072 output tokens. Reasoning: `None` (off), `Low` (reasoning capped at 8,192 tokens, or half the output limit if that is smaller), `High` (no cap). NVIDIA's own low-effort switch has no effect on this model, so `Low` uses a reasoning budget instead. Tool calls, including several in parallel, work natively.

**Nemotron 3.5 Lightning.** Default text fallback and summarization model. Compact 30B/3B-active MoE for fast agentic turns. 1M context, up to 32,768 output tokens. Reasoning: `None`, `Medium`, `High`, `XHigh`; defaults to `Medium` because reasoning shares the answer's token budget. Text-only; vision requests fail over to `fallback.visionModel`.

**Muse Glimmer.** Reasoning: `None`, `Minimal`, `Low`, `Medium`, `High`, `Max`.

**DeepSeek V4.1 Flash.** Multimodal MoE model with 1M context and up to 262,144 output tokens, NVIDIA's default for this model. Reasoning shares that budget with the answer. Strong on algorithms, debugging, schema design, SQL, and refactors. Native vision support for visual code analysis and diagrams. Reasoning: `None`, `Low`, `High`, `Max`.

**Step 5 Preview.** StepFun's 600B/27B-active preview model for agentic coding and professional work, with 1M context, tools, and image input. The model card allows output up to the full 1M context, but output and input share that window, so the extension caps output at 262,144 tokens and keeps about 775K for the conversation. It always reasons, and the reasoning shows in the Thinking block. There is no Reasoning Mode to pick: NVIDIA accepts effort levels for it but they make no difference, and switching thinking off moves the reasoning into the answer text instead of stopping it. Preview models can be withdrawn on short notice.

**MiniMax M3.1 Flash.** Native multimodal MoE model (428B total, 23B active) with a 262,144-token context window on NVIDIA NIM, up to 65,536 output tokens, tool calling, and image input. Thinking is adaptive: on trivial turns it can answer directly, and on harder turns it reasons in the Thinking block at the selected effort level (`Low`, `Medium`, `High`, `XHigh`, `Max`).

**Mistral Large 4.** Mistral AI's multimodal MoE model (about 1T total, 49B active) with 1M context shared between input and output. NVIDIA allows up to 262,144 output tokens, so the extension keeps the rest for the conversation. It always reasons, and the reasoning shows in the Thinking block. Reasoning: `Low`, `Medium`, `High` (default); there is no way to switch it off, so `None` uses `Low`. Tool calls, including several in parallel, and image input work natively.


---

## Reasoning (Thinking) Blocks

### Collapsible Thinking Blocks

DeepSeek V4, Nemotron 3.5 Super VL, and GLM 5.3 Flash produce an internal stream of logical thought before the final answer. The extension filters `<thought>`, `<think>`, and `[THINK]` tags and renders them via VS Code's `LanguageModelThinkingPart`. In Copilot Chat you see a collapsible **Thinking...** bar; click to expand and read the step-by-step reasoning, or leave it collapsed to focus on the response.

### Controlling Reasoning Effort

Reasoning is on by default: `High` for every model except Nemotron 3.5 Lightning, which uses `Medium`. You can change it in two ways:

1. Per model: choose **Reasoning Mode** next to the model in the Copilot model picker. This choice wins over the setting.
2. As the default for all models: `nvidia-nim.reasoning.mode` in the VS Code Settings UI or `settings.json`. It becomes the preselected Reasoning Mode in the picker. A model without that mode uses its closest one, and once you set it, it applies to Lightning too.

Summaries of long conversations and image analysis always run with reasoning off, so their short replies are not used up by thinking. Step 5 Preview is the exception: it always reasons, so it is a poor choice for `nvidia-nim.context.summarizationModel`.

