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
});
