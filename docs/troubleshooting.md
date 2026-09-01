# Troubleshooting & FAQ

Diagnostics guide, common HTTP error codes, debugging workflows, and security details.

---

## How to View and Export Debug Logs

If something goes wrong, save the session file. Debug logging does not need to be on first.

1. Open the Command Palette (`Ctrl + Shift + P` / `Cmd + Shift + P`).
2. Run `NVIDIA NIM: Save Session Logs` (the older `Save Last Turn Report` command does the same thing). This writes one JSON file to your Downloads folder with recent turns and technical events. Attach that file to a GitHub issue.
3. Run `NVIDIA NIM: Open Debug Log` if you still need the Output panel.
4. *(Optional)* Enable `nvidia-nim.developer.debugLogging` in the Settings UI or `settings.json` for a live technical trace. SSE chunk dumps and outgoing message bodies stay off unless you also enable `nvidia-nim.developer.logStreamChunks` / `nvidia-nim.developer.logUserMessages`.

---

## Common Error Codes and Fixes

### HTTP 401 Unauthorized / Invalid API Key

- **Cause:** Mistyped, expired, or empty API key.
- **Fix:** Generate a fresh key at [build.nvidia.com](https://build.nvidia.com) and run `NVIDIA NIM: Manage NVIDIA NIM API Key` to save it.

### HTTP 404 Not Found / HTTP 410 Gone

- **Cause:** The model endpoint is decommissioned (`410 Gone`) or unavailable for this key (`404 Not Found`).
- **Fix:** With `"nvidia-nim.fallback.enabled": true`, the extension handles this automatically. Otherwise, switch to `Nemotron 3 Super 120B`, `DeepSeek V4`, or `Muse Glimmer`.

### HTTP 429 Too Many Requests / 529 Overloaded

- **Cause:** NVIDIA NIM rate limit reached on the free tier.
- **Fix:** Failover routes the current prompt to the backup model; the next prompt retries the primary model.

### HTTP 502 / 503 Service Overloaded

- **Cause:** NVIDIA NIM accepted the request but the model backend is overloaded. This can arrive as an HTTP status or as an error object inside the stream.
- **Fix:** The extension retries the same model, then failsover to the backup if the retry still returns nothing. Wait a minute if every candidate is overloaded. You do not need to switch models by hand.

### Request timed out waiting for stream data

- **Cause:** Slow network or high server load.
- **Fix:** Raise `"nvidia-nim.network.streamIdleTimeout"` in `settings.json` (e.g. from `120` to `240`).

---

## Privacy & Security

- **Direct TLS Communication:** All requests travel directly between your VS Code client and `https://integrate.api.nvidia.com/v1`. There are no intermediary proxy servers.
- **Secure Secret Vault:** The API key is encrypted in VS Code's OS-level `SecretStorage` (Windows Credential Manager, macOS Keychain, Linux Secret Service).
- **Zero Data Retention:** The extension stores no chat messages, file contents, or telemetry on disk.
