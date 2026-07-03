import * as vscode from "vscode";
import {
  getToolSchemaMap,
  extractChatRequestContext,
  getCompletedToolCallKeys,
  buildToolCallCanonicalKey,
  isToolCallInput,
  hasRequiredToolArguments,
  repairToolArguments,
  ToolSchema,
} from "../tools/parser";
import { debugLog } from "../shared/logging";

export interface SkippedToolCall {
  name: string;
  required: string[];
}

export interface ToolCallStreamAggregatorOptions {
  options: vscode.ProvideLanguageModelChatResponseOptions;
  messages: readonly vscode.LanguageModelChatMessage[];
  onEmitToolCall: (id: string, name: string, args: Record<string, unknown>) => void;
  onSkipToolCall: (name: string, required: string[]) => void;
}

export class ToolCallStreamAggregator {
  private toolSchemas: Map<string, ToolSchema>;
  private requestContext: any;
  private emittedTextToolCallKeys: Set<string>;
  private onEmitToolCall: (id: string, name: string, args: Record<string, unknown>) => void;
  private onSkipToolCall: (name: string, required: string[]) => void;

  private toolCallBuffers = new Map<number, { id?: string; name?: string; args: string }>();
  private completedToolCallIndices = new Set<number>();

  private sawToolCall = false;
  private emittedToolCall = false;


  constructor(options: ToolCallStreamAggregatorOptions) {
    this.toolSchemas = getToolSchemaMap(options.options);
    this.requestContext = extractChatRequestContext(options.messages);
    this.emittedTextToolCallKeys = getCompletedToolCallKeys(options.messages, this.requestContext, this.toolSchemas);
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

  public getRequestContext(): any {
    return this.requestContext;
  }

  public getEmittedTextToolCallKeys(): Set<string> {
    return this.emittedTextToolCallKeys;
  }

  public handleToolCalls(deltas: any[]): void {
    this.sawToolCall = true;
    for (const tc of deltas) {
      const idx = (tc as { index?: number }).index ?? 0;
      if (this.completedToolCallIndices.has(idx)) {
        continue;
      }

      const buf = this.toolCallBuffers.get(idx) ?? { args: "" };
      if (tc.id && typeof tc.id === "string") {
        buf.id = tc.id;
      }
      const func = tc.function;
      if (func?.name && typeof func.name === "string") {
        buf.name = func.name;
      }
      if (typeof func?.arguments === "string") {
        buf.args += func.arguments;
      }
      this.toolCallBuffers.set(idx, buf);

      if (buf.args.trim().length === 0) {
        continue;
      }

      try {
        const schema = this.toolSchemas.get(buf.name ?? "");
        const args = repairToolArguments(
          buf.name ?? "",
          buf.args ? JSON.parse(buf.args) : {},
          this.requestContext,
          schema,
        );
        if (
          buf.id &&
          buf.name &&
          isToolCallInput(args) &&
          hasRequiredToolArguments(args, schema)
        ) {
          const canonicalKey = buildToolCallCanonicalKey(buf.name, args);
          if (this.emittedTextToolCallKeys.has(canonicalKey)) {
            this.completedToolCallIndices.add(idx);
            this.toolCallBuffers.delete(idx);
            continue;
          }
          this.onEmitToolCall(buf.id, buf.name, args);
          this.emittedToolCall = true;

          this.emittedTextToolCallKeys.add(canonicalKey);
          this.completedToolCallIndices.add(idx);
          this.toolCallBuffers.delete(idx);
        } else if (buf.id && buf.name) {
          this.onSkipToolCall(buf.name, schema?.required ?? []);
          debugLog("Skipped invalid tool call", { id: buf.id, name: buf.name, args });
          this.completedToolCallIndices.add(idx);
          this.toolCallBuffers.delete(idx);
        }
      } catch {
        // JSON incomplete — wait for next chunk
      }
    }
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
          buf.args ? JSON.parse(buf.args) : {},
          this.requestContext,
          schema,
        );
        if (
          buf.id &&
          buf.name &&
          isToolCallInput(args) &&
          hasRequiredToolArguments(args, schema)
        ) {
          const canonicalKey = buildToolCallCanonicalKey(buf.name, args);
          if (this.emittedTextToolCallKeys.has(canonicalKey)) {
            continue;
          }
          this.onEmitToolCall(buf.id, buf.name, args);
          this.emittedToolCall = true;

          this.emittedTextToolCallKeys.add(canonicalKey);
        } else if (buf.id && buf.name) {
          this.onSkipToolCall(buf.name, schema?.required ?? []);
          debugLog("Skipped invalid tool call at stream end", {
            id: buf.id,
            name: buf.name,
            args,
          });
        }
      } catch {
        // Ignore incomplete JSON at stream end
      }
    }
  }
}
