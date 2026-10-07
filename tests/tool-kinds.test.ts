import { isDirTool, isEditTool, isReadTool, isTerminalTool } from "../src/tools/tool-kinds";
import { isValidToolIdentifier, repairToolArguments } from "../src/tools/parser";
import { ToolSchema } from "../src/tools/tool-schema";

describe("tool-kinds", () => {
  it("classifies read tools by exact name and tokens, not substrings", () => {
    expect(isReadTool("read_file")).toBe(true);
    expect(isReadTool("view_file")).toBe(true);
    expect(isReadTool("thread")).toBe(false);
    expect(isReadTool("already_read")).toBe(false);
    expect(isReadTool("mcp_read_file")).toBe(true);
    expect(isEditTool("create_issue")).toBe(false);
  });

  it("does not treat file_info as an edit tool", () => {
    expect(isEditTool("file_info")).toBe(false);
    expect(isEditTool("edit_file")).toBe(true);
    expect(isEditTool("create_file")).toBe(true);
  });

  it("classifies terminal and directory tools by tokens", () => {
    expect(isTerminalTool("run_in_terminal")).toBe(true);
    expect(isTerminalTool("read_file")).toBe(false);
    expect(isDirTool("list_dir")).toBe(true);
    expect(isDirTool("grep_search")).toBe(true);
    expect(isDirTool("read_file")).toBe(false);
  });

  it("classifies Copilot harness tools by exact name", () => {
    expect(isEditTool("edit")).toBe(true);
    expect(isEditTool("create")).toBe(true);
    expect(isReadTool("view")).toBe(true);

    for (const name of ["bash", "write_bash", "stop_bash", "list_bash"]) {
      expect(isTerminalTool(name)).toBe(true);
    }
    for (const name of [
      "powershell",
      "read_powershell",
      "write_powershell",
      "stop_powershell",
      "list_powershell",
    ]) {
      expect(isTerminalTool(name)).toBe(true);
      expect(isEditTool(name)).toBe(false);
    }

    // Shell / sub-agent output readers are not file reads.
    expect(isReadTool("read_bash")).toBe(false);
    expect(isTerminalTool("read_bash")).toBe(true);
    expect(isReadTool("read_powershell")).toBe(false);
    expect(isReadTool("read_agent")).toBe(false);
    expect(isReadTool("write_bash")).toBe(false);

    expect(isDirTool("grep")).toBe(true);
    expect(isDirTool("glob")).toBe(true);
  });

  it("keeps Local agent classification unchanged", () => {
    const kinds = (name: string): string =>
      [
        isReadTool(name) && "read",
        isEditTool(name) && "edit",
        isTerminalTool(name) && "terminal",
        isDirTool(name) && "dir",
      ]
        .filter(Boolean)
        .join("+") || "none";

    expect(
      Object.fromEntries(
        [
          "read_file",
          "replace_string_in_file",
          "multi_replace_string_in_file",
          "insert_edit_into_file",
          "create_file",
          "apply_patch",
          "run_in_terminal",
          "get_terminal_output",
          "list_dir",
          "grep_search",
          "file_search",
          "get_errors",
          "fetch_webpage",
          "runSubagent",
        ].map((name) => [name, kinds(name)]),
      ),
    ).toEqual({
      read_file: "read",
      replace_string_in_file: "edit",
      multi_replace_string_in_file: "edit",
      insert_edit_into_file: "edit",
      create_file: "edit",
      apply_patch: "edit",
      run_in_terminal: "terminal",
      get_terminal_output: "terminal",
      list_dir: "dir",
      grep_search: "dir",
      file_search: "none",
      get_errors: "none",
      fetch_webpage: "read",
      runSubagent: "none",
    });
  });

  it("gives the Windows powershell tool the same terminal repair as bash", () => {
    const schema: ToolSchema = {
      required: ["command", "description", "mode"],
      properties: {
        command: { type: "string" },
        description: { type: "string" },
        mode: { type: "string", enum: ["sync", "async"] },
      },
      enumValues: { mode: ["sync", "async"] },
    };
    const args = { command: "npm test", description: "Run tests" };

    expect(repairToolArguments("bash", args, undefined, schema).mode).toBe("sync");
    expect(repairToolArguments("powershell", args, undefined, schema).mode).toBe("sync");
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
