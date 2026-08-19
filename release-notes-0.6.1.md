# v0.6.1

## Smart Vision Fallback & Model Status Updates

This release fixes image failovers by automatically routing requests with images to a vision-capable backup model, adds a dedicated vision fallback setting, and updates model availability notices.

---

## What's New

### 🖼️ Vision-Aware Automatic Fallback
Previously, if a primary vision model failed (such as on a rate limit or server 404), failover unconditionally switched to the default text model, resulting in an error rejecting the image.

Now, failover is **multimodal-aware**:
- **Text requests** continue to route to your fast text fallback model (default: **Nemotron 3.5 Lightning 30B**).
- **Image requests** automatically switch to a high-capacity vision backup model (default: **MiniMax M3**, featuring 1,000,000 context tokens and full image understanding).

### ⚙️ Dedicated `fallback.visionModel` Setting
You can now independently configure which model handles fallback for vision requests:
- Setting: `nvidia-nim.fallback.visionModel` (default: `minimaxai/minimax-m3`).
- If you set your main `fallback.model` to a vision-capable model (like `Step 3.7 Flash`), the extension seamlessly respects it.

### ⚠️ Kimi k2.6 Status Update
NVIDIA NIM's endpoint for `moonshotai/kimi-k2.6` is currently returning `404 Not Found`. To keep you informed:
- It is now marked as **Kimi k2.6 (Deprecated)** in the Copilot model picker.
- If selected, requests will automatically and smoothly fail over to **MiniMax M3** without crashing.

---

## Install / Update

Install from [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=neuraldock.nvidia-nim-agent), update via VS Code Extensions view, or download `nvidia-nim-agent-0.6.1.vsix` and use **Install from VSIX...**.
