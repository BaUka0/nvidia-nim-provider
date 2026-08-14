# v0.5.2

## Recovery that actually recovers

When a prompt hits the model's context limit, the extension compacts earlier turns and tries again. This usually saved the conversation — except when the retry's answer was a tool call or a burst of reasoning: those used to get dropped silently, and a huge tool result could push the retried prompt over the limit a second time.

That is fixed in this release:

- **Tool calls survive the retry.** If the model answers the compacted prompt by calling a tool (reading a file, running a command), the call now comes through intact.
- **Reasoning is not lost.** Thinking output produced during the retry is shown just like in a normal turn.
- **Huge tool outputs are trimmed** before the retry, so the second attempt actually fits.

## Fewer wasted requests when things go wrong

Retry logic nested on top of retry logic could fire an outsized burst of requests — potentially ~9 or more — against an API that was already struggling. Every response now has a shared budget for connection attempts, so recovery is a controlled second chance instead of a quiet quota-burning loop.

## Sharper, more honest errors

- A server reply like `invalid value for 'max_tokens'` is now reported as the validation problem it is, instead of being mistaken for "your conversation is too long" and triggering pointless history compression.
- Rate-limit fallbacks are detected by error type, not by parsing message text, so they trigger exactly when they should.
- If a network drop interrupts a step, the recovery instruction is sent in a form every backend accepts — nothing gets rejected for malformed message roles.

## Safer image analysis

The image-analysis tool now checks its input before calling out: it requires a proper base64 image data URL and refuses remote links and oversized payloads (over 20 MB).

## Under the hood

- Cryptographically random tool-call IDs, consistent token estimates, and logging that can't crash on circular data.
- Removed dead code and tightened internals — the build, lint, and 494 automated tests are all green.

## Little quality-of-life touches

The status-bar token breakdown stays clickable, so you can refresh the model list without hunting for the command.

## Install

Download the `nvidia-nim-agent-0.5.2.vsix` file and install it from the VS Code Extensions view using **Install from VSIX...**