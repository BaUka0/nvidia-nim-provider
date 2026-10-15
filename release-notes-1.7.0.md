# v1.7.0 — Two New Models, Accurate Context With Images

This release adds Step 5 Preview and Nemotron 3.5 Super VL, removes the retired Kimi K3, and fixes how images count toward a model's context, so long chats with screenshots are shortened before they overflow.

## What changed for you

* **Step 5 Preview.** StepFun's preview model is in the model picker: 1M-token context, up to 262,144 output tokens, tool calling, and image input. It always reasons, and its reasoning shows in the Thinking block. There is no Reasoning Mode to pick, because NVIDIA's endpoint does not let its reasoning be turned down or off. It scores 44 on the Artificial Analysis Intelligence Index. As a preview model, NVIDIA may withdraw it on short notice.
* **Nemotron 3.5 Super VL.** NVIDIA's Super model with image input: 1M-token context, up to 131,072 output tokens, and tool calling, including several calls at once. Reasoning Mode offers `None`, `Low`, and `High`. `Low` caps reasoning at 8,192 tokens, because NVIDIA's own low-effort switch makes no difference on this model. It scores 26 on the Artificial Analysis Intelligence Index.
* **Kimi K3 removed.** NVIDIA retired Kimi K3 on October 15, 2026, and it no longer answers requests. If it was your backup or summarization model, the default model is used instead. You can pick another one in the VS Code Settings UI or `settings.json`.
* **Long chats with screenshots.** Images were counted by file size, so a typical screenshot cost about eight times more context than the extension expected, and long chats with images could run past the model's limit unnoticed. Images are now counted by their size in pixels, the way the models charge for them. Muse Glimmer, which has the smallest context window, was hit hardest: it answered such requests with a server error instead of having the conversation shortened.
* **More accurate context usage overall.** Conversations with many short messages or many tools are counted more accurately, so long agent sessions are shortened before they overflow rather than after.
* **Shorter Nemotron names.** The model picker shows Nemotron 3 Ultra, Nemotron 3 Super, Nemotron 3.5 Lightning, and Nemotron 3.5 Super VL, without the parameter count. Your selected model and settings stay as they are.
* **Agents window in the README.** The README no longer says NVIDIA NIM models work in VS Code's separate Agents window; they do not yet. They do work in Copilot sessions in the regular chat view, and the README explains how to turn that on.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-1.7.0.vsix` package.
