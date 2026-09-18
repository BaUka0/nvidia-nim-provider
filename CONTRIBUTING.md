# Contributing to NVIDIA NIM Agent

Thank you for your interest in contributing to **NVIDIA NIM Agent**!

---

## 📌 Project Status: Feature-Complete & Maintenance Mode

As of version **v1.1.0**, the project has achieved all core architectural goals:
* Autonomous agentic workflows and tool-calling repair
* Live reasoning streaming via native `LanguageModelThinkingPart`
* Multi-tiered model failover with automatic chain recovery
* Repetition guard and loop breaker
* Context auto-compaction and token usage tracking

The product is considered **feature-complete**. Ongoing development is dedicated to:
* **Bug fixes and stability improvements**
* **Adapting to upstream NVIDIA NIM API changes and model catalog updates**
* **Compatibility updates for newer VS Code releases**

> [!NOTE]
> This is a personal open-source project maintained in spare time. Issues and pull requests are reviewed periodically in batches rather than on a 24/7 on-call basis.

---

## 🐛 Reporting Bugs

If you run into an issue, please submit a report using the [Bug Report Issue Template](https://github.com/BaUka0/nvidia-nim-provider/issues/new?template=bug_report.yml).

To help investigate and resolve the problem efficiently, please include:
1. **Model & Reasoning Mode:** Which model and reasoning effort level (`None`, `Low`, `Medium`, `High`, `Max`) were active.
2. **Diagnostic Logs (drag-and-drop or attach files):**
   * **Session Log** (`Ctrl+Shift+P` / `Cmd+Shift+P` → `NVIDIA NIM: Save Session Logs`): Essential for extension errors, HTTP 503/429 status codes, connection drops, or tool execution failures.
   * **Last Turn Report** (`Ctrl+Shift+P` / `Cmd+Shift+P` → `NVIDIA NIM: Save Last Turn Report`): Essential for model anomalies, degenerate repetition loops (e.g. repeated lines, "Let me..." loops), or truncated responses.
     > *Tip:* Repetition loops are often non-deterministic and hard to reproduce on demand. The **Last Turn Report** captures the exact prompt, turn history, and model output needed to diagnose and fix loop guards.

*(All sensitive credentials and API keys are automatically redacted by the built-in diagnostic commands).*

---

## 💡 Feature & Model Requests

Suggestions for new NVIDIA NIM models, helpful configuration options, or workflow improvements are always welcome!

* Submit your ideas via the [Feature or Model Request Template](https://github.com/BaUka0/nvidia-nim-provider/issues/new?template=feature_or_model_request.yml).
* New models and enhancements are evaluated and implemented based on necessity, practical utility for everyday developer workflows, and maintainer availability.
* Community contributions and PRs adding verified model adapters or catalog entries are warmly appreciated.

---

## 💻 Local Development & Pull Requests

Pull requests for bug fixes, test improvements, and catalog maintenance are very welcome!

### Prerequisites

* [Node.js](https://nodejs.org/) (v20 or v22+ recommended)
* [npm](https://www.npmjs.com/)
* [VS Code](https://code.visualstudio.com/) (v1.125.0+)

### Setup

```bash
git clone https://github.com/BaUka0/nvidia-nim-provider.git
cd nvidia-nim-provider
npm install
npm run compile
```

### Verification & Testing

Before submitting a pull request, ensure all tests and linter checks pass:

```bash
# Run unit test suite (~800 tests across 39 suites)
npm test

# Run ESLint validation
npm run lint

# Format codebase
npm run format
```

### Guidelines for PRs

1. **Include Tests:** When fixing a bug, add a regression test in the appropriate suite under `tests/`.
2. **Keep PRs Focused:** Avoid bundling unrelated refactorings or cosmetic changes with bug fixes.
3. **Respect Architecture:** Follow established modular boundaries (`src/api/`, `src/messages/`, `src/models/`, `src/provider/`, `src/shared/`).

---

## ☕ Supporting the Project

If **NVIDIA NIM Agent** saves you subscription fees, improves your daily coding workflow, or helps in autonomous agent tasks, consider supporting development:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy_me_a_coffee-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/baurzhanbissanov)

Every donation is greatly appreciated and helps keep maintenance active!
