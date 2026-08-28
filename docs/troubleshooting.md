# Troubleshooting & FAQ

Diagnostics guide, common HTTP error codes, debugging workflows, and security details.

---

## How to View and Export Debug Logs

If something goes wrong, the debug log shows what happened:

1. Open the Command Palette (`Ctrl + Shift + P` / `Cmd + Shift + P`).
2. Run `NVIDIA NIM: Save Last Turn Report`. This writes a small JSON file to your Downloads folder (no debug toggle required). Attach that file to a GitHub issue.
3. Run `NVIDIA NIM: Open Debug Log` if you still need the Output panel.
4. *(Optional)* Run `NVIDIA NIM: Toggle Debug Logging` to enable full chunk-by-chunk logging.

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

### Request timed out waiting for stream data

- **Cause:** Slow network or high server load.
- **Fix:** Raise `"nvidia-nim.network.streamIdleTimeout"` in `settings.json` (e.g. from `120` to `240`).

---

## Privacy & Security

- **Direct TLS Communication:** All requests travel directly between your VS Code client and `https://integrate.api.nvidia.com/v1`. There are no intermediary proxy servers.
- **Secure Secret Vault:** The API key is encrypted in VS Code's OS-level `SecretStorage` (Windows Credential Manager, macOS Keychain, Linux Secret Service).
- **Zero Data Retention:** The extension stores no chat messages, file contents, or telemetry on disk.
