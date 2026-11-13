import {
  isDirTool,
  isEditTool,
  isInspectionTool,
  isMutatingTool,
  isReadTool,
  isTerminalTool,
} from "../src/tools/tool-kinds";
import { isValidToolIdentifier } from "../src/tools/parser";

describe("tool-kinds", () => {
  it("classifies read tools by exact name and tokens, not substrings", () => {
    expect(isReadTool("read_file")).toBe(true);
    expect(isReadTool("view_file")).toBe(true);
    expect(isReadTool("mcp_read_file")).toBe(true);
    expect(isReadTool("read_resource")).toBe(true);
    expect(isReadTool("thread")).toBe(false);
    expect(isReadTool("already_read")).toBe(false);
    expect(isEditTool("create_issue")).toBe(false);
  });

  it("excludes web, image, screenshot, and issue/PR tools without file hints from isReadTool", () => {
    expect(isReadTool("fetch_webpage")).toBe(false);
    expect(isReadTool("fetch_url")).toBe(false);
    expect(isReadTool("mcp_fetch_url")).toBe(false);
    expect(isReadTool("read_webpage")).toBe(false);
    expect(isReadTool("view_image")).toBe(false);
    expect(isReadTool("view_screenshot")).toBe(false);
    expect(isReadTool("view_dom")).toBe(false);
    expect(isReadTool("get_issue")).toBe(false);
    expect(isReadTool("view_issue")).toBe(false);
    expect(isReadTool("show_pr")).toBe(false);
    // Tools that explicitly carry a file hint remain read tools
    expect(isReadTool("web_read_file")).toBe(true);
    expect(isReadTool("fetch_file_contents")).toBe(true);
  });

  it("does not treat file_info as an edit tool and recognizes Copilot/agent edit names", () => {
    expect(isEditTool("file_info")).toBe(false);
    expect(isEditTool("edit_file")).toBe(true);
    expect(isEditTool("create_file")).toBe(true);
    expect(isEditTool("edit")).toBe(true);
    expect(isEditTool("multi_edit")).toBe(true);
    expect(isEditTool("str_replace_editor")).toBe(true);
    expect(isEditTool("notebook_edit")).toBe(true);
    expect(isEditTool("copilot_editFile")).toBe(true);
  });

  it("classifies terminal and directory tools by tokens while excluding terminal reads", () => {
    expect(isTerminalTool("run_in_terminal")).toBe(true);
    expect(isTerminalTool("read_file")).toBe(false);
    expect(isTerminalTool("get_terminal_output")).toBe(false);
    expect(isTerminalTool("get_terminal_last_command")).toBe(false);
    expect(isTerminalTool("vscode_getTerminalOutput")).toBe(false);
    expect(isTerminalTool("read_terminal")).toBe(false);
    expect(isTerminalTool("terminal_last_command")).toBe(false);
    expect(isTerminalTool("terminal_selection")).toBe(false);
    expect(isDirTool("list_dir")).toBe(true);
    expect(isDirTool("grep_search")).toBe(true);
    expect(isDirTool("read_file")).toBe(false);
  });

  it("splits camelCase boundaries when classifying mutating and inspection tools", () => {
    expect(isMutatingTool("vscode_renameSymbol")).toBe(true);
    expect(isMutatingTool("copilot_editFile")).toBe(true);
    expect(isMutatingTool("run_notebook_cell")).toBe(true);
    expect(isMutatingTool("edit")).toBe(true);
    expect(isMutatingTool("create_directory")).toBe(true);
    expect(isMutatingTool("read_file")).toBe(false);
    expect(isMutatingTool("list_dir")).toBe(false);
    expect(isMutatingTool("get_terminal_output")).toBe(false);

    expect(isInspectionTool("read_file")).toBe(true);
    expect(isInspectionTool("list_dir")).toBe(true);
    expect(isInspectionTool("get_errors")).toBe(true);
    expect(isInspectionTool("vscode_listCodeUsages")).toBe(true);
    expect(isInspectionTool("get_terminal_output")).toBe(true);
    expect(isInspectionTool("terminal_last_command")).toBe(true);
    expect(isInspectionTool("terminal_selection")).toBe(true);
    expect(isInspectionTool("mcp_inspect_schema")).toBe(true);
    expect(isInspectionTool("vscode_renameSymbol")).toBe(false);
    expect(isInspectionTool("copilot_editFile")).toBe(false);
    expect(isInspectionTool("run_notebook_cell")).toBe(false);
    expect(isInspectionTool("mcp_custom_action")).toBe(false);
    expect(isInspectionTool("do_something")).toBe(false);
  });
});

describe("isValidToolIdentifier", () => {
  it("rejects prototype-polluting identifiers", () => {
    expect(isValidToolIdentifier("__proto__")).toBe(false);
    expect(isValidToolIdentifier("constructor")).toBe(false);
    expect(isValidToolIdentifier("prototype")).toBe(false);
    expect(isValidToolIdentifier("read_file")).toBe(true);
  });
});
