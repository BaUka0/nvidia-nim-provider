# Getting Started

Step-by-step setup for using NVIDIA NIM models in VS Code and GitHub Copilot Chat.

---

## Step 1: Get a Free NVIDIA NIM API Key

NVIDIA provides free inference credits to developers on its Build platform.

1. Open [build.nvidia.com/explore/discover](https://build.nvidia.com/explore/discover).
2. Click **Log In** (top-right). Sign in with Google, GitHub, or email.
3. Click any model (e.g. DeepSeek V4 Pro 0813, Nemotron 3 Super 120B).
4. Click **Get API Key** or **Generate API Key**.
5. Copy the key. It starts with `nvapi-...`. Treat it like a password.

---

## Step 2: Install Requirements

You need:

1. VS Code `1.125.0` or newer.
2. The GitHub Copilot extension, signed in.
3. The NVIDIA NIM Agent extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=neuraldock.nvidia-nim-agent).

---

## Step 3: Enter the API Key in VS Code

Two ways to store the key.

### Method A: Via the Copilot Chat Model Selector (Recommended)

1. Open GitHub Copilot Chat (`Ctrl + Alt + I` on Windows/Linux, `Cmd + Alt + I` on macOS).
2. Click the model dropdown at the bottom of the chat input.
3. Click **Manage Models...** then select **NVIDIA NIM**.
4. Paste your `nvapi-...` key and press **Enter**.

### Method B: Via the Command Palette

1. Press `Ctrl + Shift + P` (or `Cmd + Shift + P` on macOS).
2. Type `NVIDIA NIM: Manage NVIDIA NIM API Key` and press **Enter**.
3. Paste the key and press **Enter**.

The key is encrypted inside the OS-native credential vault via VS Code `SecretStorage` (Windows Credential Manager, macOS Keychain, Linux Secret Service). It is never sent to a third party and never written to logs in plain text.

---

## Step 4: Select a Model and Start Chatting

1. In Copilot Chat, open the model selector dropdown.
2. Pick a model under the **NVIDIA NIM** group (e.g. DeepSeek V4 Pro 0813, Nemotron 3 Super 120B, MiniMax M3).
3. Send a message.

---

## Next Steps

- Explore the available models and reasoning options in the [Model Guide](models.md).
- Learn about automated resilience in the [Failover Engine](failover.md).
- Customize behavior using the [Configuration Reference](configuration.md).
