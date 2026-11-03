import {
  buildTitle,
  describeFailure,
  filesIn,
  findSection,
  loadModelNames,
  needsBetterTitle,
  run,
} from "../.github/scripts/issue-report-check";

type Args = Record<string, unknown>;

const TURN_REPORT = JSON.stringify({
  extension: "nvidia-nim-provider",
  version: "1.10.1",
  turns: [],
});
const SESSION_LOG = JSON.stringify({
  extension: "nvidia-nim-provider",
  version: "1.10.1",
  settings: {},
  turns: [],
  events: [],
});

const file = (id: number, name: string) =>
  `[${name}](https://github.com/user-attachments/files/${id}/${name})`;
const url = (id: number, name: string) => `https://github.com/user-attachments/files/${id}/${name}`;

function formBody({
  description = "It broke after view_image.",
  report = "_No response_",
  sessionLog = "_No response_",
} = {}): string {
  return [
    "### Problem Description",
    "",
    description,
    "",
    "### Active Model",
    "",
    "mistralai/mistral-large-4-1t-a52b",
    "",
    "### Last Turn Report",
    "",
    report,
    "",
    "### Session Log (optional)",
    "",
    sessionLog,
  ].join("\n");
}

function makeGithub(comments: Array<{ user: { type: string }; body: string }> = []) {
  const calls: Array<[string, Args]> = [];
  const record = (name: string) =>
    jest.fn(async (args: Args) => {
      calls.push([name, args]);
      return { data: {} };
    });
  const github = {
    rest: {
      issues: {
        removeLabel: record("removeLabel"),
        addLabels: record("addLabels"),
        createLabel: record("createLabel"),
        createComment: record("createComment"),
        update: record("update"),
        listComments: jest.fn(),
      },
    },
    paginate: jest.fn(async () => comments),
  };
  return { github, calls, names: () => calls.map(([name]) => name) };
}

function makeFetch(files: Record<string, string | undefined> = {}) {
  return jest.fn(async (target: string) => {
    const text = files[target];
    return { ok: text !== undefined, text: async () => text ?? "" };
  });
}

const core = { info: jest.fn() };

function issuesContext(
  body: string,
  {
    action = "opened",
    state = "open",
    labels = ["bug"],
    changes = { body: { from: "" } } as Args | undefined,
    title = "[Bug]: Answers stop after view_image",
  } = {},
) {
  return {
    eventName: "issues",
    repo: { owner: "o", repo: "r" },
    payload: {
      action,
      changes,
      issue: {
        number: 7,
        title,
        state,
        body,
        labels: labels.map((name) => ({ name })),
        user: { login: "reporter" },
      },
    },
  };
}

function commentContext(
  body: string,
  commentBody: string,
  {
    login = "reporter",
    state = "closed",
    labels = ["bug", "needs-report"],
    title = "[Bug]: Answers stop after view_image",
  } = {},
) {
  return {
    eventName: "issue_comment",
    repo: { owner: "o", repo: "r" },
    payload: {
      action: "created",
      issue: {
        number: 7,
        title,
        state,
        body,
        labels: labels.map((name) => ({ name })),
        user: { login: "reporter" },
      },
      comment: { id: 99, user: { login }, body: commentBody },
    },
  };
}

const commentBodies = (calls: Array<[string, Args]>) =>
  calls.filter(([name]) => name === "createComment").map(([, args]) => String(args.body));

describe("issue report check: issue events", () => {
  it("leaves a report with the file in Last Turn Report alone", async () => {
    const { github, calls } = makeGithub();
    const body = formBody({ report: file(1, "nvidia-nim-turn-report-1.json") });
    await run({ github, context: issuesContext(body), core, fetchImpl: makeFetch() });
    expect(calls).toEqual([]);
  });

  it("closes a report with pasted JSON instead of a file", async () => {
    const { github, calls, names } = makeGithub();
    const body = formBody({ report: '{\n  "extension": "nvidia-nim-provider",\n  "turns": []\n}' });
    await run({ github, context: issuesContext(body), core, fetchImpl: makeFetch() });
    expect(names()).toEqual(["createLabel", "addLabels", "createComment", "update"]);
    const [comment] = commentBodies(calls);
    expect(comment).toContain("No report file is attached in the **Last Turn Report** field.");
    expect(comment).toContain("<!-- report-check: missing -->");
    expect(calls.at(-1)?.[1]).toMatchObject({ state: "closed", state_reason: "not_planned" });
  });

  it("rejects a file in Problem Description and a turn report in Session Log", async () => {
    const { github, calls } = makeGithub();
    const report = file(2, "nvidia-nim-turn-report-2.json");
    const body = formBody({ description: report, report, sessionLog: report });
    const fetchImpl = makeFetch({ [url(2, "nvidia-nim-turn-report-2.json")]: TURN_REPORT });
    await run({ github, context: issuesContext(body), core, fetchImpl });
    const [comment] = commentBodies(calls);
    expect(comment).toContain("A file is attached in **Problem Description**.");
    expect(comment).toContain("The file in **Session Log** is a turn report");
    expect(comment).toContain("<!-- report-check: description-file,session-log-turn-report -->");
  });

  it("accepts a real session log in Session Log", async () => {
    const { github, calls } = makeGithub();
    const body = formBody({
      report: file(3, "nvidia-nim-turn-report-3.json"),
      sessionLog: file(4, "nvidia-nim-session-4.json"),
    });
    const fetchImpl = makeFetch({ [url(4, "nvidia-nim-session-4.json")]: SESSION_LOG });
    await run({ github, context: issuesContext(body), core, fetchImpl });
    expect(calls).toEqual([]);
  });

  it("recognizes a file from a form upload field", () => {
    // Rendering of `type: upload` fields, as seen on public issues.
    const section = findSection(
      formBody({ report: file(34276488, "nvidia-nim-turn-report-20261102.json") }),
      "Last Turn Report",
    );
    expect(filesIn(section?.text ?? "")).toEqual([
      url(34276488, "nvidia-nim-turn-report-20261102.json"),
    ]);
  });

  it("does not count screenshots as report files", () => {
    expect(filesIn("![shot](https://github.com/user-attachments/assets/4b1c-uuid)")).toEqual([]);
  });

  it("reopens a flagged issue once the file is in place", async () => {
    const { github, calls, names } = makeGithub();
    const body = formBody({ report: file(5, "nvidia-nim-turn-report-5.json") });
    const context = issuesContext(body, {
      action: "edited",
      state: "closed",
      labels: ["bug", "needs-report"],
    });
    await run({ github, context, core, fetchImpl: makeFetch() });
    expect(names()).toEqual(["removeLabel", "update", "createComment"]);
    expect(calls[1][1]).toMatchObject({ state: "open" });
    expect(commentBodies(calls)).toEqual(["Report file found, reopening."]);
  });

  it("does not repeat the same complaint on a closed issue", async () => {
    const { github, calls } = makeGithub([
      { user: { type: "Bot" }, body: "closed\n<!-- report-check: missing -->" },
    ]);
    const context = issuesContext(formBody(), {
      action: "edited",
      state: "closed",
      labels: ["bug", "needs-report"],
    });
    await run({ github, context, core, fetchImpl: makeFetch() });
    expect(calls).toEqual([]);
  });

  it("comments again when the problems change", async () => {
    const { github, calls } = makeGithub([
      { user: { type: "Bot" }, body: "closed\n<!-- report-check: missing -->" },
    ]);
    const report = file(6, "nvidia-nim-turn-report-6.json");
    const context = issuesContext(formBody({ description: report, report }), {
      action: "edited",
      state: "closed",
      labels: ["bug", "needs-report"],
    });
    await run({ github, context, core, fetchImpl: makeFetch() });
    expect(commentBodies(calls)[0]).toContain("<!-- report-check: description-file -->");
  });

  it("skips a title-only edit", async () => {
    const { github, calls } = makeGithub();
    const context = issuesContext(formBody(), {
      action: "edited",
      changes: { title: { from: "x" } },
    });
    await run({ github, context, core, fetchImpl: makeFetch() });
    expect(calls).toEqual([]);
  });

  it("skips issues that did not come from the bug form", async () => {
    const { github, calls } = makeGithub();
    await run({ github, context: issuesContext("Just a question."), core, fetchImpl: makeFetch() });
    expect(calls).toEqual([]);
  });

  it("moves an error dump filed as a feature request to bug and closes it", async () => {
    const { github, calls, names } = makeGithub();
    const body =
      "### What would you like to see?\n\n[INVALID_REQUEST] NVIDIA NIM rejected the request.";
    await run({
      github,
      context: issuesContext(body, { labels: ["enhancement"] }),
      core,
      fetchImpl: makeFetch(),
    });
    expect(names()).toEqual(["removeLabel", "addLabels", "createComment", "update"]);
    expect(calls[1][1]).toMatchObject({ labels: ["bug"] });
  });
});

describe("issue report check: comments by the reporter", () => {
  const reportName = "nvidia-nim-turn-report-20261102.json";

  it("moves a report from a comment into Last Turn Report and reopens the issue", async () => {
    const { github, calls, names } = makeGithub();
    const body = formBody({ report: '{\n  "turns": []\n}' });
    const fetchImpl = makeFetch({ [url(8, reportName)]: TURN_REPORT });
    await run({
      github,
      context: commentContext(body, `here\n\n${file(8, reportName)}`),
      core,
      fetchImpl,
    });

    expect(names()).toEqual(["update", "removeLabel", "update", "createComment"]);
    const newBody = String(calls[0][1].body);
    expect(findSection(newBody, "Last Turn Report")?.text.trim()).toBe(file(8, reportName));
    expect(newBody).not.toContain('"turns"');
    expect(findSection(newBody, "Session Log (optional)")?.text.trim()).toBe("_No response_");
    expect(calls[2][1]).toMatchObject({ state: "open" });
    expect(commentBodies(calls)).toEqual([
      "Moved the report file from your comment into **Last Turn Report**.\n\nReport file found, reopening.",
    ]);
  });

  it("moves a renamed file when its content is a report", async () => {
    const { github, calls } = makeGithub();
    const fetchImpl = makeFetch({ [url(9, "What.The.Flying.Fuck.json")]: TURN_REPORT });
    await run({
      github,
      context: commentContext(formBody(), file(9, "What.The.Flying.Fuck.json")),
      core,
      fetchImpl,
    });
    expect(String(calls[0][1].body)).toContain(url(9, "What.The.Flying.Fuck.json"));
  });

  it("moves a report named by the extension even when it cannot be downloaded", async () => {
    const { github, calls } = makeGithub();
    await run({
      github,
      context: commentContext(formBody(), file(10, reportName)),
      core,
      fetchImpl: makeFetch(),
    });
    expect(String(calls[0][1].body)).toContain(url(10, reportName));
  });

  it("ignores files that are not extension reports", async () => {
    const { github, calls } = makeGithub();
    const fetchImpl = makeFetch({ [url(11, "package.json")]: '{"name":"x"}' });
    await run({
      github,
      context: commentContext(formBody(), file(11, "package.json")),
      core,
      fetchImpl,
    });
    expect(calls).toEqual([]);
  });

  it("ignores comments by anyone but the reporter", async () => {
    const { github, calls } = makeGithub();
    const fetchImpl = makeFetch({ [url(12, reportName)]: TURN_REPORT });
    await run({
      github,
      context: commentContext(formBody(), file(12, reportName), { login: "someone-else" }),
      core,
      fetchImpl,
    });
    expect(calls).toEqual([]);
  });

  it("leaves the body alone when Last Turn Report already has a file", async () => {
    const { github, calls } = makeGithub();
    const fetchImpl = makeFetch({ [url(13, reportName)]: TURN_REPORT });
    const body = formBody({ report: file(1, "nvidia-nim-turn-report-1.json") });
    await run({ github, context: commentContext(body, file(13, reportName)), core, fetchImpl });
    expect(calls).toEqual([]);
  });

  it("still lists the remaining problems after moving the file", async () => {
    const { github, calls, names } = makeGithub();
    const fetchImpl = makeFetch({ [url(14, reportName)]: TURN_REPORT });
    const body = formBody({ description: file(15, "nvidia-nim-turn-report-15.json") });
    await run({ github, context: commentContext(body, file(14, reportName)), core, fetchImpl });
    expect(names()[0]).toBe("update");
    const [comment] = commentBodies(calls);
    expect(comment).toMatch(/^Moved the report file from your comment/);
    expect(comment).toContain("<!-- report-check: description-file -->");
    expect(calls.at(-1)?.[1]).toMatchObject({ state: "closed" });
  });
});

describe("issue report check: titles", () => {
  const dumpTitle =
    '[Bug]:       "errorMessage": "[INVALID_REQUEST] NVIDIA NIM rejected the request.\nDetails: HTTP 400: {\\"message\\":\\"Invalid request\\",\\"type\\":\\"Bad Request\\",\\"code\\":400}"';
  const errorTurn = {
    outcome: "error",
    modelId: "mistralai/mistral-large-4-1t-a52b",
    requestTail: "tool_result",
    errorKind: "invalid_request",
    errorMessage:
      '[INVALID_REQUEST] NVIDIA NIM rejected the request.\nDetails: HTTP 400: {"message":"Invalid request","type":"Bad Request","code":400}',
  };
  // Shape of the #61 report: two view_image calls, then the same request failing four times.
  const report = {
    extension: "nvidia-nim-provider",
    version: "1.10.1-beta.1",
    turns: [
      {
        outcome: "ok",
        modelId: "mistralai/mistral-large-4-1t-a52b",
        requestTail: "user",
        emittedToolCalls: [
          { id: "a", name: "view_image" },
          { id: "b", name: "view_image" },
        ],
      },
      errorTurn,
      errorTurn,
      errorTurn,
      errorTurn,
    ],
  };
  const reportName = "nvidia-nim-turn-report-20261102.json";
  const modelNames = loadModelNames();

  it("reads model display names from the catalog", () => {
    expect(modelNames["mistralai/mistral-large-4-1t-a52b"]).toBe("Mistral Large 4");
  });

  it("flags pasted error messages and empty titles, not plain descriptions", () => {
    expect(needsBetterTitle(dumpTitle)).toBe(true);
    expect(needsBetterTitle("[Bug]: ")).toBe(true);
    expect(needsBetterTitle("[Bug]: NvidiaApiError at stream.js:42")).toBe(true);
    expect(needsBetterTitle("[Bug]: step5 abrupt end (cont)")).toBe(false);
    expect(needsBetterTitle("[Bug]: Mistral error handling")).toBe(false);
  });

  it("describes the last failed turn and the tools it answered", () => {
    expect(describeFailure(report)).toEqual({
      modelId: "mistralai/mistral-large-4-1t-a52b",
      code: "INVALID_REQUEST",
      status: "400",
      tools: ["view_image"],
    });
    expect(describeFailure({ ...report, turns: [report.turns[0]] })).toBeUndefined();
  });

  it("builds a title from the report", () => {
    const failure = describeFailure(report);
    expect(buildTitle({ failure, title: dumpTitle, activeModel: "", modelNames })).toBe(
      "[Bug]: Mistral Large 4 fails with INVALID_REQUEST (HTTP 400) after view_image",
    );
  });

  it("falls back to the pasted message and the Active Model field without a report", () => {
    expect(
      buildTitle({
        title: dumpTitle,
        activeModel: "mistralai/mistral-large-4-1t-a52b",
        modelNames,
      }),
    ).toBe("[Bug]: Mistral Large 4 fails with INVALID_REQUEST (HTTP 400)");
    expect(
      buildTitle({ title: "[Bug]: ", activeModel: "Other / Not sure / General issue", modelNames }),
    ).toBeUndefined();
  });

  it("retitles a new issue whose title is a pasted error message", async () => {
    const { github, calls } = makeGithub();
    const body = formBody({ report: file(20, reportName) });
    const fetchImpl = makeFetch({ [url(20, reportName)]: JSON.stringify(report) });
    await run({
      github,
      context: issuesContext(body, { title: dumpTitle }),
      core,
      fetchImpl,
      modelNames,
    });
    expect(calls).toEqual([
      [
        "update",
        expect.objectContaining({
          issue_number: 7,
          title: "[Bug]: Mistral Large 4 fails with INVALID_REQUEST (HTTP 400) after view_image",
        }),
      ],
    ]);
  });

  it("retitles when the reporter edits only the title back to a dump", async () => {
    const { github, calls } = makeGithub();
    const context = issuesContext(formBody(), {
      action: "edited",
      changes: { title: { from: "x" } },
      title: dumpTitle,
    });
    await run({ github, context, core, fetchImpl: makeFetch(), modelNames });
    expect(calls.map(([name]) => name)).toEqual(["update"]);
    expect(calls[0][1].title).toBe("[Bug]: Mistral Large 4 fails with INVALID_REQUEST (HTTP 400)");
  });

  it("keeps a title someone wrote by hand", async () => {
    const { github, calls } = makeGithub();
    const body = formBody({ report: file(21, reportName) });
    const fetchImpl = makeFetch({ [url(21, reportName)]: JSON.stringify(report) });
    await run({
      github,
      context: issuesContext(body, { title: "[Bug]: step5 abrupt end (cont)" }),
      core,
      fetchImpl,
      modelNames,
    });
    expect(calls).toEqual([]);
  });

  it("retitles after moving a report out of a comment", async () => {
    const { github, calls } = makeGithub();
    const fetchImpl = makeFetch({ [url(22, reportName)]: JSON.stringify(report) });
    await run({
      github,
      context: commentContext(formBody(), file(22, reportName), { title: dumpTitle }),
      core,
      fetchImpl,
      modelNames,
    });
    expect(
      calls.map(([name, args]) => (name === "update" ? Object.keys(args).at(-1) : name)),
    ).toEqual(["body", "title", "removeLabel", "state", "createComment"]);
  });
});
