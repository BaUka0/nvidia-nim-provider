import {
  extractStandaloneXmlParameters,
  isTokenInStringOrRegexLiteral,
  scanXmlToolConstruct,
} from "../src/tools/xml-tool-scanner";

describe("isTokenInStringOrRegexLiteral", () => {
  it("treats a tool tag inside return'...' as a string", () => {
    const text = "return'hello <tool_call>'";
    expect(isTokenInStringOrRegexLiteral(text, text.indexOf("<tool_call>"))).toBe(true);
  });

  it("does not treat a tool tag after a contraction or plural possessive as a string", () => {
    const contraction = "Let's <tool_call>";
    const possessive = "users' <tool_call>";
    expect(isTokenInStringOrRegexLiteral(contraction, contraction.indexOf("<tool_call>"))).toBe(
      false,
    );
    expect(isTokenInStringOrRegexLiteral(possessive, possessive.indexOf("<tool_call>"))).toBe(
      false,
    );
  });
});

describe("scanXmlToolConstruct", () => {
  const parseValue = (raw: string): unknown => raw.trim();
  const isValidName = (name: string): boolean => /^[a-zA-Z0-9_.-]+$/.test(name);

  it("scans a nested Hermes function with parameters", () => {
    const text =
      "<tool_call>\n<function=read_file>\n<parameter=filePath>/tmp/a.ts</parameter>\n</function>\n</tool_call>";
    const result = scanXmlToolConstruct(text, parseValue, isValidName);
    expect(result.status).toBe("complete");
    if (result.status === "complete") {
      expect(result.toolCall?.name).toBe("read_file");
      expect(result.toolCall?.args).toEqual({ filePath: "/tmp/a.ts" });
    }
  });

  it("returns incomplete for a mismatched closing tag until more input arrives", () => {
    const text = "<tool_call>\n<function=read_file>\n<parameter=filePath>/tmp/a.ts</parameter>";
    const result = scanXmlToolConstruct(text, parseValue, isValidName);
    expect(result.status).toBe("incomplete");
  });

  it("does not treat a quoted tag inside a parameter as a closer", () => {
    const text =
      '<tool_call>\n<function=edit_file>\n<parameter=newString>const end = "</tool_call>";</parameter>\n</function>\n</tool_call>';
    const result = scanXmlToolConstruct(text, parseValue, isValidName);
    expect(result.status).toBe("complete");
    if (result.status === "complete") {
      expect(result.toolCall?.args.newString).toContain("</tool_call>");
    }
  });

  it("skips a lone close tag that is not a tool construct", () => {
    const text = "</tool_call> leftover";
    const result = scanXmlToolConstruct(text, parseValue, isValidName);
    expect(result.status === "not-a-tag" || result.status === "complete").toBe(true);
  });

  it("tolerates stray or balanced quotes on <function=...> and <parameter=...> tags", () => {
    const text =
      '<tool_call>\n<function=read_file">\n<parameter=filePath>/tmp/a.ts</parameter>\n<parameter=startLine">10</parameter>\n<parameter="endLine">20</parameter>\n</function>\n</tool_call>';
    const result = scanXmlToolConstruct(text, parseValue, isValidName);
    expect(result.status).toBe("complete");
    if (result.status === "complete") {
      expect(result.toolCall?.name).toBe("read_file");
      expect(result.toolCall?.args).toEqual({
        filePath: "/tmp/a.ts",
        startLine: "10",
        endLine: "20",
      });
    }
  });
});

describe("extractStandaloneXmlParameters", () => {
  it("extracts escaped parameter values without swallowing the rest of the text", () => {
    const { cleanText, extractedParams } = extractStandaloneXmlParameters(
      "Hello <parameter=filePath>/tmp/a.ts</parameter> world",
      (raw) => raw.trim(),
    );
    expect(extractedParams).toEqual({ filePath: "/tmp/a.ts" });
    expect(cleanText).toContain("Hello");
    expect(cleanText).toContain("world");
  });

  it("extracts parameters when the model emits a stray trailing quote after the parameter name", () => {
    const { cleanText, extractedParams } = extractStandaloneXmlParameters(
      '\n\n<parameter=filePath>/tmp/a.ts</parameter>\n\n<parameter=startLine">10</parameter>\n\n<parameter=endLine">20</parameter>\n',
      (raw) => raw.trim(),
    );
    expect(extractedParams).toEqual({
      filePath: "/tmp/a.ts",
      startLine: "10",
      endLine: "20",
    });
    expect(cleanText.trim()).toBe("");
  });

  it("extracts unclosed standalone parameters when the server stripped closing </parameter> tags", () => {
    const raw =
      '\n\n<parameter name="mode">sync\n\n<parameter name="timeout">920000\n\n<parameter name="explanation">Build the icon font with corrected nix-shell quoting\n\n<parameter name="goal">Generate the hinted icon font\n\n<parameter name="command">cd /home/orange/skin.cane && timeout 900 .venv/bin/python tools/build-icons.py 2>&1 | tail -40';
    const { cleanText, extractedParams } = extractStandaloneXmlParameters(raw, (val) => val.trim());
    expect(extractedParams).toEqual({
      mode: "sync",
      timeout: "920000",
      explanation: "Build the icon font with corrected nix-shell quoting",
      goal: "Generate the hinted icon font",
      command:
        "cd /home/orange/skin.cane && timeout 900 .venv/bin/python tools/build-icons.py 2>&1 | tail -40",
    });
    expect(cleanText.trim()).toBe("");
  });

  it("holds unclosed parameter tags during streaming and closes them at stream end", () => {
    const raw = '<parameter name="mode">sync\n\n<parameter name="command">npm test';
    expect(
      scanXmlToolConstruct(
        raw,
        (val) => val.trim(),
        () => true,
        false,
      ),
    ).toEqual({ status: "incomplete" });

    expect(
      scanXmlToolConstruct(
        raw,
        (val) => val.trim(),
        () => true,
        true,
      ),
    ).toEqual({
      status: "complete",
      consumed: '<parameter name="mode">sync\n\n'.length,
      extractedParams: { mode: "sync" },
    });
  });
});
