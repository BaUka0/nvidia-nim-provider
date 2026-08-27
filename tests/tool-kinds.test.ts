import { isDirTool, isEditTool, isReadTool, isTerminalTool } from "../src/tools/tool-kinds";
import { isValidToolIdentifier } from "../src/tools/parser";

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
});

describe("isValidToolIdentifier", () => {
  it("rejects prototype-polluting identifiers", () => {
    expect(isValidToolIdentifier("__proto__")).toBe(false);
    expect(isValidToolIdentifier("constructor")).toBe(false);
    expect(isValidToolIdentifier("prototype")).toBe(false);
    expect(isValidToolIdentifier("read_file")).toBe(true);
  });
});
