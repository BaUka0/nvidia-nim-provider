/**
 * Tool-name taxonomy used by argument repair.
 * Classification is exact-name plus tokenized segments (split on `_`, `-`, `.`)
 * so `"thread"` is not a read tool and `"file_info"` is not an edit tool.
 *
 * Token rules were written for the VS Code Local agent (`read_file`,
 * `replace_string_in_file`, `run_in_terminal`). The Copilot harness (Copilot
 * SDK / CLI runtime) uses bare names (`edit`, `create`, `powershell`) and
 * `read_*` shell readers, so those are pinned by exact name below.
 */

function tokenizeToolName(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hasToken(parts: readonly string[], tokens: ReadonlySet<string>): boolean {
  return parts.some((part) => tokens.has(part));
}

const READ_TOOL_EXACT = new Set([
  "read_file",
  "view_file",
  "read_text_file",
  "readfile",
  "get_file",
  "get_file_contents",
]);
/** Copilot harness readers of shell / sub-agent output: `read_` prefix, not a file read. */
const NOT_READ_TOOL_EXACT = new Set(["read_bash", "read_powershell", "read_agent"]);
const READ_TOOL_TOKENS = new Set(["read", "view", "fetch", "show", "cat"]);
const FILE_HINT_TOKENS = new Set(["file", "files", "contents", "path"]);

const EDIT_TOOL_EXACT = new Set([
  "edit_file",
  "write_file",
  "create_file",
  "patch_file",
  "replace_file_content",
  "apply_patch",
  "delete_file",
  // Copilot harness file tools: bare verbs with no file token.
  "edit",
  "create",
]);
const EDIT_TOOL_TOKENS = new Set([
  "edit",
  "write",
  "create",
  "patch",
  "replace",
  "insert",
  "delete",
  "apply",
]);

const TERMINAL_TOOL_EXACT = new Set([
  "run_in_terminal",
  "run_terminal_cmd",
  "run_terminal_command",
  // Copilot harness on Windows; the `*_bash` family already matches the `bash` token.
  "powershell",
  "read_powershell",
  "write_powershell",
  "stop_powershell",
  "list_powershell",
]);
const TERMINAL_TOOL_TOKENS = new Set(["terminal", "shell", "bash", "exec"]);

const DIR_TOOL_EXACT = new Set(["list_dir", "list_directory", "grep_search", "find_files"]);
const DIR_TOOL_TOKENS = new Set(["dir", "directory", "grep", "glob"]);

export function isReadTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  if (READ_TOOL_EXACT.has(normalized)) {
    return true;
  }
  if (NOT_READ_TOOL_EXACT.has(normalized)) {
    return false;
  }
  const parts = tokenizeToolName(normalized);
  if (!hasToken(parts, READ_TOOL_TOKENS)) {
    return false;
  }
  return parts[0] !== undefined && READ_TOOL_TOKENS.has(parts[0])
    ? true
    : hasToken(parts, FILE_HINT_TOKENS);
}

export function isTerminalTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  if (TERMINAL_TOOL_EXACT.has(normalized)) {
    return true;
  }
  const parts = tokenizeToolName(normalized);
  if (hasToken(parts, TERMINAL_TOOL_TOKENS)) {
    return true;
  }
  return parts.includes("command") && (parts.includes("run") || parts.includes("terminal"));
}

export function isEditTool(toolName: string): boolean {
  if (isReadTool(toolName) || isTerminalTool(toolName)) {
    return false;
  }
  const normalized = toolName.toLowerCase();
  if (EDIT_TOOL_EXACT.has(normalized)) {
    return true;
  }
  const parts = tokenizeToolName(normalized);
  return hasToken(parts, EDIT_TOOL_TOKENS) && hasToken(parts, FILE_HINT_TOKENS);
}

export function isDirTool(toolName: string): boolean {
  if (isReadTool(toolName) || isEditTool(toolName) || isTerminalTool(toolName)) {
    return false;
  }
  const normalized = toolName.toLowerCase();
  if (DIR_TOOL_EXACT.has(normalized)) {
    return true;
  }
  const parts = tokenizeToolName(normalized);
  if (hasToken(parts, DIR_TOOL_TOKENS)) {
    return true;
  }
  return parts.includes("list") && parts.includes("dir");
}
