import * as vscode from "vscode";
import { registerOcGoTools } from "../src/tools";

jest.mock("vscode", () => ({
  Disposable: {
    from: jest.fn(() => ({ dispose: jest.fn() })),
  },
  lm: {
    registerTool: jest.fn(() => ({ dispose: jest.fn() })),
  },
}));

describe("registerOcGoTools", () => {
  it("returns a disposable without registering MCP-backed tools", () => {
    const secrets = { get: jest.fn() } as any;
    const disposable = registerOcGoTools(secrets);
    expect(disposable).toBeDefined();
    expect(typeof disposable.dispose).toBe("function");
    expect(vscode.Disposable.from).toHaveBeenCalled();
    expect((vscode as any).lm.registerTool).not.toHaveBeenCalled();
  });
});
