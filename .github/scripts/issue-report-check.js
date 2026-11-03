// @ts-check
/**
 * Bug report file check, run by .github/workflows/issue-report-check.yml
 * through actions/github-script. Kept as a module so
 * tests/issue-report-check.test.ts can drive it with a mocked GitHub client.
 *
 * Bug reports must attach the turn report as a file in the Last Turn Report
 * field. Pasted JSON is truncated, hard to read, and bloats the thread.
 */

const LABEL = "needs-report";
const MARKER_PREFIX = "<!-- report-check:";
const FEATURE_HEADER = "### What would you like to see?";
const ERROR_DUMP =
  /NvidiaApiError|\[[A-Z_]+\] NVIDIA NIM|neuraldock\.nvidia-nim-agent-[\w.-]+[\\/]out[\\/]/;

// Drag-and-drop uploads and form upload fields render as
// [name](https://github.com/user-attachments/files/<id>/<name>) (older
// uploads: github.com/<owner>/<repo>/files/<id>/<name>). Screenshots upload
// as user-attachments/assets/<uuid> and are not matched.
const ATTACHMENT =
  /https:\/\/github\.com\/(?:user-attachments|[\w.-]+\/[\w.-]+)\/files\/\d+\/[^\s)\]]+\.(?:json|zip|txt|log)\b/gi;

const REPORT_INSTRUCTIONS =
  "Run `NVIDIA NIM: Save Last Turn Report` from the Command Palette right after the failing turn, then edit this issue and drag and drop the saved `nvidia-nim-turn-report-*.json` file into the **Last Turn Report** field. Pasted JSON text does not count. The issue reopens automatically once the report is in place.";

/** Content bounds of a `### <label>` form section, or undefined. */
function findSection(body, label) {
  const header = `### ${label}`;
  const start = body.indexOf(header);
  if (start === -1) return undefined;
  const contentStart = start + header.length;
  const next = body.slice(contentStart).search(/\n### /);
  const contentEnd = next === -1 ? body.length : contentStart + next;
  return { contentStart, contentEnd, text: body.slice(contentStart, contentEnd) };
}

function filesIn(text) {
  return [...text.matchAll(ATTACHMENT)].map((m) => m[0]);
}

/** Parsed JSON of an attached file, or undefined when it cannot be read. */
async function readJson(url, fetchImpl, core) {
  if (!/\.json$/i.test(url)) return undefined;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return undefined;
    return JSON.parse(await res.text());
  } catch (err) {
    core.info(`Could not read ${url}: ${err}`);
    return undefined;
  }
}

// Save Last Turn Report writes { extension, version, generatedAt, turns };
// Save Session Logs adds `settings` and `events`.
function isExtensionReport(data) {
  return data?.extension === "nvidia-nim-provider" && Array.isArray(data.turns);
}

function isTurnReport(data) {
  return isExtensionReport(data) && !Array.isArray(data.events);
}

const TITLE_PREFIX = "[Bug]: ";

/**
 * Display names from src/models/catalog.ts, keyed by model id. The workflow
 * checks that file out next to this script; an empty map falls back to ids.
 */
function loadModelNames(catalogPath = "src/models/catalog.ts") {
  try {
    const source = require("fs").readFileSync(catalogPath, "utf8");
    return Object.fromEntries(
      [...source.matchAll(/"([^"]+)":\s*\{\s*displayName:\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]),
    );
  } catch {
    return {};
  }
}

/** A title left as the form prefix, or a pasted error message, JSON or stack. */
function needsBetterTitle(title) {
  const rest = title.replace(/^\s*\[Bug\]:?/i, "").trim();
  return (
    rest.length === 0 ||
    rest.length > 120 ||
    ERROR_DUMP.test(rest) ||
    /\\"|errorMessage|[{}]/.test(rest)
  );
}

/** Model, error code, HTTP status and preceding tool of the last failed turn. */
function describeFailure(report) {
  const turns = isExtensionReport(report) ? report.turns : [];
  const index = turns.findLastIndex((turn) => turn?.outcome === "error");
  if (index === -1) return undefined;
  const turn = turns[index];
  const message = typeof turn.errorMessage === "string" ? turn.errorMessage : "";
  const code = message.match(/^\[([A-Z_]+)\]/)?.[1] ?? turn.errorKind?.toUpperCase();
  const status = message.match(/\bHTTP (\d{3})\b/)?.[1];
  // Earlier failed attempts of the same turn sit between it and the turn whose tool calls it answers.
  const previous = turns.slice(0, index).findLast((t) => t?.outcome !== "error");
  const tools =
    turn.requestTail === "tool_result" && Array.isArray(previous?.emittedToolCalls)
      ? [...new Set(previous.emittedToolCalls.map((call) => call?.name).filter(Boolean))]
      : [];
  return { modelId: turn.modelId, code, status, tools };
}

/** A descriptive title for a bug report, or undefined when there is too little to go on. */
function buildTitle({ failure, title, activeModel, modelNames }) {
  const dumped = title.match(/\[([A-Z_]+)\] NVIDIA NIM/)?.[1];
  const code = failure?.code ?? dumped;
  if (!code) return undefined;
  const status = failure?.status ?? title.match(/\bHTTP (\d{3})\b/)?.[1];
  const modelId = failure?.modelId ?? (activeModel.includes("/") ? activeModel : undefined);
  const model = modelId ? (modelNames[modelId] ?? modelId) : undefined;
  const after = failure?.tools.length ? ` after ${failure.tools.join(", ")}` : "";
  return `${TITLE_PREFIX}${model ? `${model} fails` : "Request fails"} with ${code}${status ? ` (HTTP ${status})` : ""}${after}`;
}

/** Replace a title that is a pasted error dump (or empty) with one built from the report. */
async function fixTitle({ github, core, repo, issue, body, fetchImpl, modelNames }) {
  const title = issue.title ?? "";
  const report = findSection(body, "Last Turn Report");
  if (!report || !needsBetterTitle(title)) return;
  const [file] = filesIn(report.text);
  const failure = file ? describeFailure(await readJson(file, fetchImpl, core)) : undefined;
  const activeModel = findSection(body, "Active Model")?.text.trim() ?? "";
  const newTitle = buildTitle({ failure, title, activeModel, modelNames });
  if (!newTitle || newTitle === title) return;
  await github.rest.issues.update({ ...repo, issue_number: issue.number, title: newTitle });
  core.info(`Retitled to "${newTitle}".`);
}

/** Close an error dump filed through the feature form; true when handled. */
async function handleFeatureFormErrorDump({ github, repo, issue, body, labels }) {
  if (!body.includes(FEATURE_HEADER) || !ERROR_DUMP.test(body)) return false;
  const issue_number = issue.number;
  const moved = labels.includes("bug");
  await github.rest.issues
    .removeLabel({ ...repo, issue_number, name: "enhancement" })
    .catch(() => {});
  if (!moved) {
    await github.rest.issues.addLabels({ ...repo, issue_number, labels: ["bug"] });
    await github.rest.issues.createComment({
      ...repo,
      issue_number,
      body: [
        "This is an error report, not a feature request, so it is closed.",
        "",
        "Open a new issue with the **Bug Report** form, run `NVIDIA NIM: Save Last Turn Report` from the Command Palette right after the failing turn, and drag and drop the saved `nvidia-nim-turn-report-*.json` file into the **Last Turn Report** section. Pasted JSON text does not count.",
      ].join("\n"),
    });
  }
  if (issue.state !== "closed") {
    await github.rest.issues.update({
      ...repo,
      issue_number,
      state: "closed",
      state_reason: "not_planned",
    });
  }
  return true;
}

/**
 * Check a bug-form issue and label, close, or reopen it. `notes` are lines
 * that lead whatever comment the check posts (or are posted alone).
 */
async function checkIssue({ github, core, repo, issue, body, fetchImpl, notes = [] }) {
  const issue_number = issue.number;
  const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));

  if (await handleFeatureFormErrorDump({ github, repo, issue, body, labels })) return;

  // Only issues created from bug_report.yml carry these section headers.
  const report = findSection(body, "Last Turn Report");
  if (!report) {
    core.info("Not a bug report form issue; skipping.");
    return;
  }
  const description = findSection(body, "Problem Description")?.text ?? "";
  const sessionLog = findSection(body, "Session Log (optional)")?.text ?? "";

  const problems = [];
  if (filesIn(report.text).length === 0) {
    problems.push({
      key: "missing",
      text: "No report file is attached in the **Last Turn Report** field.",
    });
  }
  if (filesIn(description).length > 0) {
    problems.push({
      key: "description-file",
      text: "A file is attached in **Problem Description**. Describe the problem there in words; the report file goes in **Last Turn Report** only.",
    });
  }
  for (const url of filesIn(sessionLog)) {
    if (isTurnReport(await readJson(url, fetchImpl, core))) {
      problems.push({
        key: "session-log-turn-report",
        text: "The file in **Session Log** is a turn report, not a session log. Remove it, or replace it with the file saved by `NVIDIA NIM: Save Session Logs`.",
      });
      break;
    }
  }

  const flagged = labels.includes(LABEL);
  const postNotes = async () => {
    if (notes.length > 0) {
      await github.rest.issues.createComment({ ...repo, issue_number, body: notes.join("\n\n") });
    }
  };

  if (problems.length === 0) {
    if (!flagged) {
      core.info("Report file attached.");
      await postNotes();
      return;
    }
    await github.rest.issues.removeLabel({ ...repo, issue_number, name: LABEL }).catch(() => {});
    if (issue.state === "closed") {
      await github.rest.issues.update({ ...repo, issue_number, state: "open" });
    }
    await github.rest.issues.createComment({
      ...repo,
      issue_number,
      body: [...notes, "Report file found, reopening."].join("\n\n"),
    });
    return;
  }

  // Comment again only when the list of problems changed since the last check.
  const marker = `${MARKER_PREFIX} ${problems.map((p) => p.key).join(",")} -->`;
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...repo,
    issue_number,
    per_page: 100,
  });
  const lastCheck = comments
    .filter((c) => c.user?.type === "Bot" && c.body?.includes(MARKER_PREFIX))
    .at(-1);
  const alreadyReported = Boolean(lastCheck?.body?.includes(marker));
  if (alreadyReported && issue.state === "closed") {
    core.info("Same problems already reported; issue stays closed.");
    await postNotes();
    return;
  }

  await github.rest.issues
    .createLabel({
      ...repo,
      name: LABEL,
      color: "d93f0b",
      description: "Bug report is missing the attached turn report file",
    })
    .catch(() => {});
  await github.rest.issues.addLabels({ ...repo, issue_number, labels: [LABEL] });

  if (!alreadyReported) {
    await github.rest.issues.createComment({
      ...repo,
      issue_number,
      body: [
        ...notes,
        "This bug report is closed until the report file is attached correctly:",
        "",
        ...problems.map((p) => `- ${p.text}`),
        "",
        `${REPORT_INSTRUCTIONS} A report file you attach in a comment is moved into that field for you.`,
        "",
        marker,
      ].join("\n"),
    });
  } else {
    await postNotes();
  }
  await github.rest.issues.update({
    ...repo,
    issue_number,
    state: "closed",
    state_reason: "not_planned",
  });
}

/**
 * When the issue author attaches the report in a comment instead of the Last
 * Turn Report field, move it into the field. Returns the new body, or
 * undefined when nothing was moved. Edits made with GITHUB_TOKEN do not
 * trigger another workflow run, so the caller re-checks the issue itself.
 */
async function adoptCommentAttachment({ github, core, repo, issue, comment, fetchImpl }) {
  if (comment.user?.login !== issue.user?.login) return undefined;
  const body = issue.body ?? "";
  const report = findSection(body, "Last Turn Report");
  if (!report || filesIn(report.text).length > 0) return undefined;

  for (const url of filesIn(comment.body ?? "")) {
    const data = await readJson(url, fetchImpl, core);
    const named = /\/nvidia-nim-(?:turn-report|session)-[\w.-]*\.json$/i.test(url);
    if (!isExtensionReport(data) && !(data === undefined && named)) continue;

    const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const link = comment.body.match(new RegExp(`\\[[^\\]]*\\]\\(${escaped}\\)`))?.[0] ?? url;
    const newBody = `${body.slice(0, report.contentStart)}\n\n${link}\n${body.slice(report.contentEnd)}`;
    await github.rest.issues.update({ ...repo, issue_number: issue.number, body: newBody });
    core.info(`Moved ${url} from comment ${comment.id} into Last Turn Report.`);
    return newBody;
  }
  return undefined;
}

/** Entry point for actions/github-script. */
async function run({
  github,
  context,
  core,
  fetchImpl = globalThis.fetch,
  modelNames = loadModelNames(),
}) {
  const repo = context.repo;
  const issue = context.payload.issue;

  if (context.eventName === "issue_comment") {
    const newBody = await adoptCommentAttachment({
      github,
      core,
      repo,
      issue,
      comment: context.payload.comment,
      fetchImpl,
    });
    if (newBody === undefined) {
      core.info("Comment carries no report file to move; skipping.");
      return;
    }
    await fixTitle({ github, core, repo, issue, body: newBody, fetchImpl, modelNames });
    await checkIssue({
      github,
      core,
      repo,
      issue,
      body: newBody,
      fetchImpl,
      notes: ["Moved the report file from your comment into **Last Turn Report**."],
    });
    return;
  }

  const body = issue.body ?? "";
  await fixTitle({ github, core, repo, issue, body, fetchImpl, modelNames });

  // A maintainer retitling the issue fires `edited` without touching the body.
  if (context.payload.action === "edited" && !context.payload.changes?.body) {
    core.info("Body unchanged; skipping.");
    return;
  }
  await checkIssue({ github, core, repo, issue, body, fetchImpl });
}

module.exports = {
  run,
  findSection,
  filesIn,
  isTurnReport,
  isExtensionReport,
  loadModelNames,
  needsBetterTitle,
  describeFailure,
  buildTitle,
};
