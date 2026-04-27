export interface NvidiaModelRequestProfile {
  defaultTemperature: number;
  toolTemperature?: number;
  extraSystemMessages: string[];
}

interface NvidiaModelRequestProfileDefinition {
  matches: (modelId: string) => boolean;
  defaultTemperature: number;
  toolTemperature?: number;
  toolSystemMessages?: string[];
}

const DEFAULT_TEMPERATURE = 0.7;
const DEEPSEEK_DEFAULT_TEMPERATURE = 0;
const KIMI_DEFAULT_TEMPERATURE = 0.2;
const GLM_DEFAULT_TEMPERATURE = 0.1;
const LLAMA_DEFAULT_TEMPERATURE = 0.2;
const MISTRAL_DEFAULT_TEMPERATURE = 0.3;
const QWEN_DEFAULT_TEMPERATURE = 0.1;
const PHI_DEFAULT_TEMPERATURE = 0.3;
const YI_DEFAULT_TEMPERATURE = 0.3;
const GEMMA_DEFAULT_TEMPERATURE = 0.3;
const DEEPSEEK_TOOL_SYSTEM_MESSAGE =
  "When tools are available, either answer with normal user-facing text or emit a tool call. Do not reveal internal control tokens, protocol markers, JSON fences, planning text, or DSML/tool_call markers in the user-visible response.";
const KIMI_TOOL_SYSTEM_MESSAGE =
  "When tools are available, answer with concise user-facing text or a valid tool call. Do not reveal chain-of-thought, reasoning scratchpads, or internal reasoning markers in the user-visible response.";
const GLM_TOOL_SYSTEM_MESSAGE =
  "When calling tools, emit strict JSON arguments only. Do not wrap tool arguments in markdown fences, backticks, or explanatory prose.";
const LLAMA_TOOL_SYSTEM_MESSAGE =
  "When tools are available, answer with concise user-facing text or valid tool calls only. Do not emit pseudo tool syntax, XML-like wrappers, or tool planning markers.";
const MISTRAL_TOOL_SYSTEM_MESSAGE =
  "When tools are available, answer with concise user-facing text or a valid tool call. Do not include disclaimers, apologies, or meta-commentary about your capabilities in the response.";
const QWEN_TOOL_SYSTEM_MESSAGE =
  "When calling tools, emit a valid JSON arguments object only. Do not wrap tool arguments in markdown fences, backticks, or explanatory prose. Do not provide multiple alternative actions for the user to choose from.";
const PHI_TOOL_SYSTEM_MESSAGE =
  "When tools are available, answer with concise user-facing text or a valid tool call. Keep responses brief and direct. Do not ask follow-up questions unless necessary.";
const YI_TOOL_SYSTEM_MESSAGE =
  "When tools are available, answer with concise user-facing text or a valid tool call. Do not wrap tool arguments in markdown fences or backticks.";
const GEMMA_TOOL_SYSTEM_MESSAGE =
  "When calling tools, emit a valid JSON arguments object only. Do not include chain-of-thought reasoning or internal scratchpad text in the visible response.";

const PROFILE_DEFINITIONS: readonly NvidiaModelRequestProfileDefinition[] = [
  {
    matches: (modelId) => /(^|[\/_-])deepseek([\/_-]|$)/i.test(modelId),
    defaultTemperature: DEEPSEEK_DEFAULT_TEMPERATURE,
    toolTemperature: 0,
    toolSystemMessages: [DEEPSEEK_TOOL_SYSTEM_MESSAGE],
  },
  {
    matches: (modelId) => /(^|[\/_-])kimi([\/_-]|$)/i.test(modelId),
    defaultTemperature: KIMI_DEFAULT_TEMPERATURE,
    toolTemperature: 0.1,
    toolSystemMessages: [KIMI_TOOL_SYSTEM_MESSAGE],
  },
  {
    matches: (modelId) => /(^|[\/_-])glm([\/_-]|$)/i.test(modelId),
    defaultTemperature: GLM_DEFAULT_TEMPERATURE,
    toolTemperature: 0.05,
    toolSystemMessages: [GLM_TOOL_SYSTEM_MESSAGE],
  },
  {
    matches: (modelId) => /(^|[\/_-])llama([\/_-]|$)/i.test(modelId),
    defaultTemperature: LLAMA_DEFAULT_TEMPERATURE,
    toolTemperature: 0.1,
    toolSystemMessages: [LLAMA_TOOL_SYSTEM_MESSAGE],
  },
  {
    matches: (modelId) => /(^|[\/_-])(mistral|mixtral)([\/_-]|$)/i.test(modelId),
    defaultTemperature: MISTRAL_DEFAULT_TEMPERATURE,
    toolTemperature: 0.2,
    toolSystemMessages: [MISTRAL_TOOL_SYSTEM_MESSAGE],
  },
  {
    matches: (modelId) => /(^|[\/_-])qwen([\/_-]|$)/i.test(modelId),
    defaultTemperature: QWEN_DEFAULT_TEMPERATURE,
    toolTemperature: 0.05,
    toolSystemMessages: [QWEN_TOOL_SYSTEM_MESSAGE],
  },
  {
    matches: (modelId) => /(^|[\/_-])phi([\/_-]|$)/i.test(modelId),
    defaultTemperature: PHI_DEFAULT_TEMPERATURE,
    toolTemperature: 0.2,
    toolSystemMessages: [PHI_TOOL_SYSTEM_MESSAGE],
  },
  {
    matches: (modelId) => /(^|[\/_-])yi([\/_-]|$)/i.test(modelId),
    defaultTemperature: YI_DEFAULT_TEMPERATURE,
    toolTemperature: 0.2,
    toolSystemMessages: [YI_TOOL_SYSTEM_MESSAGE],
  },
  {
    matches: (modelId) => /(^|[\/_-])gemma([\/_-]|$)/i.test(modelId),
    defaultTemperature: GEMMA_DEFAULT_TEMPERATURE,
    toolTemperature: 0.15,
    toolSystemMessages: [GEMMA_TOOL_SYSTEM_MESSAGE],
  },
];

export function getModelRequestProfile(
  modelId: string,
  options: { toolsEnabled?: boolean } = {},
): NvidiaModelRequestProfile {
  const normalizedModelId = modelId.toLowerCase();
  const matchedProfile = PROFILE_DEFINITIONS.find((profile) => profile.matches(normalizedModelId));

  if (matchedProfile) {
    return {
      defaultTemperature: matchedProfile.defaultTemperature,
      toolTemperature: matchedProfile.toolTemperature,
      extraSystemMessages: options.toolsEnabled
        ? [...(matchedProfile.toolSystemMessages ?? [])]
        : [],
    };
  }

  return {
    defaultTemperature: DEFAULT_TEMPERATURE,
    extraSystemMessages: [],
  };
}
