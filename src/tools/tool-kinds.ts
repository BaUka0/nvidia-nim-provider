/**
 * Tool-name taxonomy used by argument repair and duplicate suppression.
 * Classification is exact-name plus tokenized segments (split on camelCase and
 * `_`, `-`, `.`) so `"thread"` is not a read tool and `"file_info"` is not an edit tool.
 */

function tokenizeToolName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hasToken(parts: readonly string[], tokens: ReadonlySet<string>): boolean {
  return parts.some((part) => tokens.has(part));
}

const NAMESPACE_PREFIXES = new Set(["vscode", "copilot", "mcp", "github", "builtin"]);
const TERMINAL_NAMESPACE_PREFIXES = new Set(["vscode", "copilot", "mcp"]);
const INSPECTION_LEADING_VERBS = new Set([
  "read",
  "view",
  "list",
  "get",
  "show",
  "fetch",
  "cat",
  "inspect",
  "check",
]);
const SEARCH_ACTION_TOKENS = new Set(["search", "grep", "glob", "find"]);

const READ_TOOL_EXACT = new Set([
  "read_file",
  "view_file",
  "read_text_file",
  "readfile",
  "get_file",
  "get_file_contents",
]);
const READ_TOOL_TOKENS = new Set(["read", "view", "fetch", "show", "cat"]);
const FILE_HINT_TOKENS = new Set(["file", "files", "contents", "path"]);
const NON_FILE_READ_TOKENS = new Set([
  "webpage",
  "web",
  "url",
  "urls",
  "http",
  "https",
  "page",
  "image",
  "images",
  "img",
  "screenshot",
  "screenshots",
  "browser",
  "dom",
  "issue",
  "issues",
  "pr",
  "prs",
  "pull",
  "commit",
  "commits",
]);

const EDIT_TOOL_EXACT = new Set([
  "edit",
  "edit_file",
  "multi_edit",
  "multiedit",
  "write_file",
  "create_file",
  "patch_file",
  "replace_file_content",
  "apply_patch",
  "delete_file",
  "str_replace_editor",
  "str_replace_based_edit_tool",
  "notebook_edit",
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
]);
const TERMINAL_TOOL_TOKENS = new Set(["terminal", "shell", "bash", "exec"]);
const TERMINAL_READ_VERBS = new Set(["get", "read", "view", "list", "show"]);

const DIR_TOOL_EXACT = new Set(["list_dir", "list_directory", "grep_search", "find_files"]);
const DIR_TOOL_TOKENS = new Set(["dir", "directory", "grep", "glob"]);

const MUTATING_TOOL_EXACT = new Set([
  "rename_symbol",
  "vscode_renamesymbol",
  "run_notebook_cell",
  "notebook_run_cell",
  "run_task",
  "create_and_run_task",
  "run_vscode_command",
  "create_directory",
  "install_extension",
  "uninstall_extension",
]);
const MUTATING_ACTION_TOKENS = new Set([
  "edit",
  "write",
  "create",
  "patch",
  "replace",
  "insert",
  "delete",
  "remove",
  "unlink",
  "move",
  "rename",
  "mkdir",
  "append",
  "save",
  "modify",
  "refactor",
  "run",
  "execute",
  "install",
  "uninstall",
]);

const INSPECTION_TOOL_EXACT = new Set([
  "file_search",
  "semantic_search",
  "codebase_search",
  "text_search",
  "find_by_name",
  "find_test_files",
  "get_errors",
  "get_diagnostics",
  "get_problems",
  "list_code_usages",
  "vscode_listcodeusages",
  "get_search_view_results",
  "get_terminal_output",
  "get_terminal_last_command",
  "terminal_last_command",
  "terminal_selection",
  "read_notebook_cell_output",
  "copilot_getnotebooksummary",
  "get_changed_files",
  "fetch_webpage",
  "view_image",
]);

export function isReadTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  if (READ_TOOL_EXACT.has(normalized)) {
    return true;
  }
  const parts = tokenizeToolName(toolName);
  if (!hasToken(parts, READ_TOOL_TOKENS)) {
    return false;
  }
  if (hasToken(parts, NON_FILE_READ_TOKENS) && !hasToken(parts, FILE_HINT_TOKENS)) {
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
  if (INSPECTION_TOOL_EXACT.has(normalized)) {
    return false;
  }
  const parts = tokenizeToolName(toolName);
  const leadingVerb = TERMINAL_NAMESPACE_PREFIXES.has(parts[0] ?? "") ? parts[1] : parts[0];
  if (leadingVerb !== undefined && TERMINAL_READ_VERBS.has(leadingVerb)) {
    return false;
  }
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
  const parts = tokenizeToolName(toolName);
  return hasToken(parts, EDIT_TOOL_TOKENS) && hasToken(parts, FILE_HINT_TOKENS);
}

export function isDirTool(toolName: string): boolean {
  if (isReadTool(toolName) || isEditTool(toolName) || isTerminalTool(toolName)) {
    return false;
  }
  const normalized = toolName.toLowerCase();
  if (MUTATING_TOOL_EXACT.has(normalized)) {
    return false;
  }
  if (DIR_TOOL_EXACT.has(normalized)) {
    return true;
  }
  const parts = tokenizeToolName(toolName);
  if (hasToken(parts, MUTATING_ACTION_TOKENS)) {
    return false;
  }
  if (hasToken(parts, DIR_TOOL_TOKENS)) {
    return true;
  }
  return parts.includes("list") && parts.includes("dir");
}

export function isMutatingTool(toolName: string): boolean {
  if (isReadTool(toolName) || isDirTool(toolName)) {
    return false;
  }
  if (isEditTool(toolName) || isTerminalTool(toolName)) {
    return true;
  }
  const normalized = toolName.toLowerCase();
  if (MUTATING_TOOL_EXACT.has(normalized)) {
    return true;
  }
  const parts = tokenizeToolName(toolName);
  return hasToken(parts, MUTATING_ACTION_TOKENS);
}

export function isInspectionTool(toolName: string): boolean {
  if (isMutatingTool(toolName)) {
    return false;
  }
  if (isReadTool(toolName) || isDirTool(toolName)) {
    return true;
  }
  const normalized = toolName.toLowerCase();
  if (INSPECTION_TOOL_EXACT.has(normalized)) {
    return true;
  }
  const parts = tokenizeToolName(toolName);
  if (hasToken(parts, SEARCH_ACTION_TOKENS)) {
    return true;
  }
  const leadingVerb = NAMESPACE_PREFIXES.has(parts[0] ?? "") ? parts[1] : parts[0];
  return leadingVerb !== undefined && INSPECTION_LEADING_VERBS.has(leadingVerb);
}
