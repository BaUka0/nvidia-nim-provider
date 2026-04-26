export interface NvidiaModelRequestProfile {
  defaultTemperature: number;
  extraSystemMessages: string[];
}

interface NvidiaModelRequestProfileDefinition {
  matches: (modelId: string) => boolean;
  defaultTemperature: number;
  toolSystemMessages?: string[];
}

const DEFAULT_TEMPERATURE = 0.7;
const DEEPSEEK_DEFAULT_TEMPERATURE = 0;
const KIMI_DEFAULT_TEMPERATURE = 0.2;
const GLM_DEFAULT_TEMPERATURE = 0.1;
const LLAMA_DEFAULT_TEMPERATURE = 0.2;
const DEEPSEEK_TOOL_SYSTEM_MESSAGE =
  "When tools are available, either answer with normal user-facing text or emit a tool call. Do not reveal internal control tokens, protocol markers, JSON fences, planning text, or DSML/tool_call markers in the user-visible response.";
const KIMI_TOOL_SYSTEM_MESSAGE =
  "When tools are available, answer with concise user-facing text or a valid tool call. Do not reveal chain-of-thought, reasoning scratchpads, or internal reasoning markers in the user-visible response.";
const GLM_TOOL_SYSTEM_MESSAGE =
  "When calling tools, emit strict JSON arguments only. Do not wrap tool arguments in markdown fences, backticks, or explanatory prose.";
const LLAMA_TOOL_SYSTEM_MESSAGE =
  "When tools are available, answer with concise user-facing text or valid tool calls only. Do not emit pseudo tool syntax, XML-like wrappers, or tool planning markers.";

const PROFILE_DEFINITIONS: readonly NvidiaModelRequestProfileDefinition[] = [
  {
    matches: (modelId) => modelId.includes("deepseek"),
    defaultTemperature: DEEPSEEK_DEFAULT_TEMPERATURE,
    toolSystemMessages: [DEEPSEEK_TOOL_SYSTEM_MESSAGE],
  },
  {
    matches: (modelId) => modelId.includes("kimi"),
    defaultTemperature: KIMI_DEFAULT_TEMPERATURE,
    toolSystemMessages: [KIMI_TOOL_SYSTEM_MESSAGE],
  },
  {
    matches: (modelId) => modelId.includes("glm"),
    defaultTemperature: GLM_DEFAULT_TEMPERATURE,
    toolSystemMessages: [GLM_TOOL_SYSTEM_MESSAGE],
  },
  {
    matches: (modelId) => modelId.includes("llama"),
    defaultTemperature: LLAMA_DEFAULT_TEMPERATURE,
    toolSystemMessages: [LLAMA_TOOL_SYSTEM_MESSAGE],
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
