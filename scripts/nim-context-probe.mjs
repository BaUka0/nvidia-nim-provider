const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";
const CALIBRATION_REPETITIONS = [1024, 4096];
const PROBE_UNIT = "x ";
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function getApiKey() {
  return (
    process.env.NIM_API_KEY ||
    process.env.NVIDIA_API_KEY ||
    process.env.NVIDIA_NIM_API_KEY ||
    process.env.NGC_API_KEY
  );
}

function getErrorMessage(payload, text) {
  if (typeof payload?.error?.message === "string") {
    return payload.error.message;
  }
  if (typeof payload?.message === "string") {
    return payload.message;
  }
  return text;
}

function parseContextError(message) {
  const maximumMatch = message.match(/maximum context length is\s*([\d,]+)/i);
  const actualMatch = message.match(/messages resulted in\s*([\d,]+)/i);
  const toNumber = (match) => (match ? Number(match[1].replaceAll(",", "")) : undefined);

  return {
    maximumContextTokens: toNumber(maximumMatch),
    actualPromptTokens: toNumber(actualMatch),
  };
}

function readPromptTokens(payload) {
  const value = payload?.usage?.prompt_tokens;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function requestCompletion({ apiKey, baseUrl, model, repetitions, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: PROBE_UNIT.repeat(repetitions) }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }

    return { response, text, payload };
  } finally {
    clearTimeout(timeout);
  }
}

function getRetryDelayMs(response, attempt) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(60000, seconds * 1000);
    }
  }
  return Math.min(60000, 5000 * 2 ** attempt);
}

async function requestCompletionWithRetry(args, label, maxRetries) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await requestCompletion(args);
    if (!RETRYABLE_STATUS_CODES.has(result.response.status) || attempt >= maxRetries) {
      return result;
    }

    const delayMs = getRetryDelayMs(result.response, attempt);
    console.error(
      `${label} received HTTP ${result.response.status}; retrying in ${Math.round(delayMs / 1000)}s ` +
        `(${attempt + 1}/${maxRetries})...`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function requireSuccessfulUsage(result, label) {
  if (!result.response.ok) {
    const message = getErrorMessage(result.payload, result.text);
    throw new Error(`${label} failed with HTTP ${result.response.status}: ${message}`);
  }

  const promptTokens = readPromptTokens(result.payload);
  if (promptTokens === undefined) {
    throw new Error(`${label} response did not include usage.prompt_tokens`);
  }
  return promptTokens;
}

export async function runContextProbe(targetContextTokens) {
  const apiKey = getApiKey();
  const model = process.argv[2] || process.env.NVIDIA_NIM_MODEL;
  const baseUrl = (process.env.NVIDIA_NIM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = Number(process.env.NVIDIA_NIM_PROBE_TIMEOUT_MS || 600000);
  const maxRetries = Number(process.env.NVIDIA_NIM_PROBE_RETRIES || 4);

  if (!apiKey) {
    throw new Error(
      "Set NIM_API_KEY (or NVIDIA_API_KEY/NVIDIA_NIM_API_KEY/NGC_API_KEY) before running a context probe.",
    );
  }
  if (!model) {
    throw new Error("Pass a model ID after -- or set NVIDIA_NIM_MODEL.");
  }
  if (!Number.isInteger(targetContextTokens) || targetContextTokens <= 1) {
    throw new Error(`Invalid target context size: ${targetContextTokens}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("NVIDIA_NIM_PROBE_TIMEOUT_MS must be a positive number.");
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("NVIDIA_NIM_PROBE_RETRIES must be a non-negative integer.");
  }

  console.error(`Calibrating NVIDIA tokenizer for ${model}...`);
  const firstResult = await requestCompletionWithRetry(
    {
      apiKey,
      baseUrl,
      model,
      repetitions: CALIBRATION_REPETITIONS[0],
      timeoutMs,
    },
    "First calibration request",
    maxRetries,
  );
  const firstTokens = requireSuccessfulUsage(firstResult, "First calibration request");
  const secondResult = await requestCompletionWithRetry(
    {
      apiKey,
      baseUrl,
      model,
      repetitions: CALIBRATION_REPETITIONS[1],
      timeoutMs,
    },
    "Second calibration request",
    maxRetries,
  );
  const secondTokens = requireSuccessfulUsage(secondResult, "Second calibration request");

  const repetitionDelta = CALIBRATION_REPETITIONS[1] - CALIBRATION_REPETITIONS[0];
  const tokensPerRepetition = (secondTokens - firstTokens) / repetitionDelta;
  const fixedPromptTokens = firstTokens - tokensPerRepetition * CALIBRATION_REPETITIONS[0];
  if (!Number.isFinite(tokensPerRepetition) || tokensPerRepetition <= 0) {
    throw new Error(`Tokenizer calibration produced an invalid slope: ${tokensPerRepetition}`);
  }

  const targetPromptTokens = targetContextTokens - 1;
  const repetitions = Math.max(
    1,
    Math.round((targetPromptTokens - fixedPromptTokens) / tokensPerRepetition),
  );
  console.error(
    `Sending ${targetContextTokens.toLocaleString()}-token probe with max_tokens=1 ` +
      `(${repetitions.toLocaleString()} calibrated repetitions)...`,
  );

  const probeResult = await requestCompletionWithRetry(
    {
      apiKey,
      baseUrl,
      model,
      repetitions,
      timeoutMs,
    },
    "Context probe request",
    maxRetries,
  );
  const message = getErrorMessage(probeResult.payload, probeResult.text);
  const contextError = parseContextError(message);
  const actualPromptTokens =
    readPromptTokens(probeResult.payload) ?? contextError.actualPromptTokens;

  const report = {
    model,
    targetContextTokens,
    targetPromptTokens,
    maxOutputTokens: 1,
    calibratedRepetitions: repetitions,
    calibration: {
      tokensPerRepetition,
      fixedPromptTokens,
    },
    httpStatus: probeResult.response.status,
    outcome: probeResult.response.ok ? "accepted" : "rejected",
    ...(actualPromptTokens !== undefined ? { actualPromptTokens } : {}),
    ...(contextError.maximumContextTokens !== undefined
      ? { reportedMaximumContextTokens: contextError.maximumContextTokens }
      : {}),
    ...(!probeResult.response.ok ? { error: message } : {}),
  };
  console.log(JSON.stringify(report, null, 2));

  if (!probeResult.response.ok) {
    process.exitCode = contextError.maximumContextTokens !== undefined ? 2 : 1;
  }
}

export async function runContextProbeCli(targetContextTokens) {
  try {
    await runContextProbe(targetContextTokens);
  } catch (error) {
    console.error(
      `Context probe failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
