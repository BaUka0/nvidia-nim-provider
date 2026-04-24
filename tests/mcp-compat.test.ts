import { OcGoMcpClient } from "../src/mcp-compat";

describe("OcGoMcpClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reads the NVIDIA NIM API key from secret storage", async () => {
    const secrets = {
      get: jest.fn(async () => undefined),
    };
    const client = new OcGoMcpClient(secrets as never);

    await expect(client.analyzeImage("data:image/png;base64,abc", "What is this?")).rejects.toThrow(
      "NVIDIA NIM API key not found",
    );
    expect(secrets.get).toHaveBeenCalledWith("nvidia-nim.apiKey");
  });
});
