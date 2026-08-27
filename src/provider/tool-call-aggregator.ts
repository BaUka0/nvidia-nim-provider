import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  getToolSchemaMap,
  extractChatRequestContext,
  getCompletedToolCallKeys,
  buildToolCallCanonicalKey,
  isDuplicateSuppressionEnabled,
  isToolCallInput,
  hasRequiredToolArguments,
  parseToolArguments,
  parseToolArgumentsStrict,
  repairToolArguments,
  ChatRequestContext,
  ToolSchema,
  SkippedToolCallReason,
} from "../tools/parser";
import { debugLog } from "../shared/logging";
import { MAX_TOOL_ARGUMENT_CHARS } from "../shared/constants";
import { NATIVE_TOOL_CALL_ID_PREFIX } from "../shared/tool-call-ids";
import { NimToolCall } from "../types";

export interface ToolCallStreamAggregatorOptions {
  options: vscode.ProvideLanguageModelChatResponseOptions;
  messages: readonly vscode.LanguageModelChatMessage[];
  onEmitToolCall: (id: string, name: string, args: Record<string, unknown>) => void;
  onSkipToolCall: (name: string, required: string[], reason?: SkippedToolCallReason) => void;
}

export class ToolCallStreamAggregator {
  private toolSchemas: Map<string, ToolSchema>;
  private requestContext: ChatRequestContext | undefined;
  private emittedTextToolCallKeys: Set<string>;
  private onEmitToolCall: (id: string, name: string, args: Record<string, unknown>) => void;
  private onSkipToolCall: (
    name: string,
    required: string[],
    reason?: SkippedToolCallReason,
  ) => void;

  private toolCallBuffers = new Map<number, { id?: string; name?: string; args: string }>();
  private completedToolCallIndices = new Set<number>();

  private sawToolCall = false;
  private emittedToolCall = false;

  constructor(options: ToolCallStreamAggregatorOptions) {
    this.toolSchemas = getToolSchemaMap(options.options);
    this.requestContext = extractChatRequestContext(options.messages);
    this.emittedTextToolCallKeys = getCompletedToolCallKeys(
      options.messages,
      this.requestContext,
      this.toolSchemas,
    );
    this.onEmitToolCall = options.onEmitToolCall;
    this.onSkipToolCall = options.onSkipToolCall;
  }

  public getSawToolCall(): boolean {
    return this.sawToolCall;
  }

  public getEmittedToolCall(): boolean {
    return this.emittedToolCall;
  }

  public getToolSchemas(): Map<string, ToolSchema> {
    return this.toolSchemas;
  }

  public getRequestContext(): ChatRequestContext | undefined {
    return this.requestContext;
  }

  public recordExtractedParameters(params: Record<string, unknown>, toolName?: string): void {
    if (!toolName) {
      return;
    }
    if (!this.requestContext) {
      this.requestContext = {};
    }
    const sameTool = this.requestContext.extractedParametersToolName === toolName;
    this.requestContext.extractedParametersToolName = toolName;
    this.requestContext.extractedParameters = {
      ...(sameTool ? (this.requestContext.extractedParameters ?? {}) : {}),
      ...params,
    };
  }

  public getEmittedTextToolCallKeys(): Set<string> {
    return this.emittedTextToolCallKeys;
  }

  public handleToolCalls(deltas: readonly NimToolCall[]): void {
    this.sawToolCall = true;
    for (const tc of deltas) {
      const idx =
        typeof (tc as { index?: number }).index === "number"
          ? (tc as { index: number }).index
          : this.toolCallBuffers.size;
      if (this.completedToolCallIndices.has(idx)) {
        continue;
      }

      const buf = this.toolCallBuffers.get(idx) ?? { args: "" };
      if (tc.id && typeof tc.id === "string") {
        buf.id = tc.id;
      }
      const func = tc.function;
      if (func?.name && typeof func.name === "string") {
        if (!buf.name || buf.name === func.name) {
          buf.name = func.name;
        } else if (func.name.startsWith(buf.name)) {
          // Some providers repeat a cumulative prefix as the name arrives.
          buf.name = func.name;
        } else if (buf.name.startsWith(func.name)) {
          // Keep the longer prefix when a provider repeats an earlier fragment.
        } else if (this.hasToolNameCandidate(`${buf.name}${func.name}`)) {
          // A complete tool name can itself be a prefix of another tool name.
          // Prefer the concatenated candidate while it still matches a known
          // name or prefix (for example, `read` + `_file` => `read_file`).
          buf.name += func.name;
        } else if (this.toolSchemas.has(func.name)) {
          buf.name = func.name;
        } else if (this.toolSchemas.has(buf.name)) {
          // A complete known name followed by an unrelated fragment should
          // not turn into a different tool name.
        } else {
          // OpenAI-compatible streams may split function names across deltas.
          buf.name += func.name;
        }
      }
      if (typeof func?.arguments === "string") {
        if (buf.args.length + func.arguments.length > MAX_TOOL_ARGUMENT_CHARS) {
          debugLog("Skipped oversized tool argument buffer", { name: buf.name });
          this.completedToolCallIndices.add(idx);
          this.toolCallBuffers.delete(idx);
          this.onSkipToolCall(buf.name ?? "unknown_tool", [], "missing_payload");
          continue;
        }
        buf.args += func.arguments;
      }
      this.toolCallBuffers.set(idx, buf);

      if (buf.args.trim().length === 0) {
        continue;
      }

      // Only emit early when the current buffer is strict JSON and already
      // satisfies its schema. Incomplete JSON and syntactically valid but
      // incomplete required arguments stay buffered until the stream ends.
      try {
        const schema = this.toolSchemas.get(buf.name ?? "");
        const args = repairToolArguments(
          buf.name ?? "",
          parseToolArgumentsStrict(buf.args),
          this.requestContext,
          schema,
        );
        if (buf.name && isToolCallInput(args) && hasRequiredToolArguments(args, schema)) {
          const canonicalKey = buildToolCallCanonicalKey(buf.name, args);
          if (
            isDuplicateSuppressionEnabled(buf.name) &&
            this.emittedTextToolCallKeys.has(canonicalKey)
          ) {
            this.onSkipToolCall(buf.name, [], "duplicate");
            this.completedToolCallIndices.add(idx);
            this.toolCallBuffers.delete(idx);
            continue;
          }
          const id =
            buf.id && buf.id.length > 0 ? buf.id : `${NATIVE_TOOL_CALL_ID_PREFIX}${randomUUID()}`;
          this.onEmitToolCall(id, buf.name, args);
          this.emittedToolCall = true;
          this.emittedTextToolCallKeys.add(canonicalKey);
          this.completedToolCallIndices.add(idx);
          this.toolCallBuffers.delete(idx);
        }
      } catch {
        // JSON is incomplete or fails schema validation; flushRemaining() will
        // repair and validate the complete buffer at stream end.
      }
    }
  }

  private hasToolNameCandidate(name: string): boolean {
    for (const knownName of this.toolSchemas.keys()) {
      if (knownName === name || knownName.startsWith(name)) {
        return true;
      }
    }
    return false;
  }

  public flushRemaining(): void {
    for (const [idx, buf] of Array.from(this.toolCallBuffers.entries())) {
      if (this.completedToolCallIndices.has(idx)) {
        continue;
      }
      try {
        const schema = this.toolSchemas.get(buf.name ?? "");
        const args = repairToolArguments(
          buf.name ?? "",
          buf.args ? parseToolArguments(buf.args) : {},
          this.requestContext,
          schema,
        );
        if (buf.name && isToolCallInput(args) && hasRequiredToolArguments(args, schema)) {
          const canonicalKey = buildToolCallCanonicalKey(buf.name, args);
          if (
            isDuplicateSuppressionEnabled(buf.name) &&
            this.emittedTextToolCallKeys.has(canonicalKey)
          ) {
            this.onSkipToolCall(buf.name, [], "duplicate");
            this.completedToolCallIndices.add(idx);
            this.toolCallBuffers.delete(idx);
            continue;
          }
          const id =
            buf.id && buf.id.length > 0 ? buf.id : `${NATIVE_TOOL_CALL_ID_PREFIX}${randomUUID()}`;
          this.onEmitToolCall(id, buf.name, args);
          this.emittedToolCall = true;

          this.emittedTextToolCallKeys.add(canonicalKey);
        } else if (buf.name || buf.id || buf.args) {
          this.onSkipToolCall(buf.name ?? "unknown_tool", schema?.required ?? []);
          debugLog("Skipped invalid tool call at stream end", {
            id: buf.id,
            name: buf.name,
            args,
          });
        }
        this.completedToolCallIndices.add(idx);
        this.toolCallBuffers.delete(idx);
      } catch {
        if (buf.name || buf.id || buf.args) {
          this.onSkipToolCall(
            buf.name ?? "unknown_tool",
            this.toolSchemas.get(buf.name ?? "")?.required ?? [],
          );
        }
        debugLog("Skipped truncated tool call at stream end", {
          id: buf.id,
          name: buf.name,
        });
        this.completedToolCallIndices.add(idx);
        this.toolCallBuffers.delete(idx);
      }
    }
  }
}
