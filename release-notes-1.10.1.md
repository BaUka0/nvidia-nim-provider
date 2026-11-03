# v1.10.1 — Image and Mistral Large 4 fixes

This release fixes chats that stopped working because of images, and two errors that Mistral Large 4 hit in agent sessions.

## Fixes

* **Mistral Large 4 continues interrupted replies.** When Copilot Chat asked Mistral Large 4 to continue a reply it had already started, the request failed with "NVIDIA NIM rejected the request". The model now picks up where that reply left off.
* **Viewing several images at once with Mistral Large 4.** Opening two or more images in one step with `view_image` failed with the same error. The images now reach the model together after all tool results.
* **Long chats with many screenshots.** NVIDIA accepts at most 8 images per request on Mistral Large 4, MiniMax M3.1 Flash, Muse Glimmer, and Step 5 Preview, and 13 on Nemotron 3.5 Super VL, counting the whole conversation. Once a chat went over that limit, every following request failed. Older images over the limit are now replaced with a short note, and the newest ones still reach the model.
* **GIF and other unsupported image formats.** NVIDIA NIM only reads PNG, JPEG, and WebP. A GIF, BMP, TIFF, or SVG image in a chat used to break every following request with "Unsupported media type"; it is now replaced with a short note telling the model the image was left out. GIFs that VS Code already converted, such as ones opened with `view_image`, still reach the model.

## Install / Update

Install from the Visual Studio Marketplace, update through the Extensions view in VS Code, or install from the `nvidia-nim-agent-1.10.1.vsix` package.
