import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Compares NVIDIA's announced retirement dates with `deprecationDate` in
 * MODEL_LIST. `/v1/models` carries no deprecation data, so the dates come from
 * each model's build.nvidia.com page, which embeds a `deprecationNotice`
 * ("This API will be deprecated on MM/DD/YYYY. ...") and an endpoint attribute
 * `{"key":"DEPRECATION","value":"MM/DD/YYYY"}`.
 *
 * Exit codes: 0 when every reachable page agrees with the catalog, 1 when a
 * date is missing from the catalog or differs from it, 2 on a script error.
 * Pages that cannot be fetched are warnings, never a missing date.
 *
 * Usage: node scripts/check-deprecations.mjs [--report <file.md>]
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogSourcePath = path.join(projectRoot, "src", "models", "catalog.ts");
const compiledCatalogPath = path.join(projectRoot, "out", "models", "catalog.js");
const BUILD_URL = "https://build.nvidia.com";

/**
 * Page slugs that neither the model id nor its dots-to-dashes form resolves.
 * Most ids work as they are; GLM 5.3 (`z-ai/glm-5-3`) is found by the dashed form.
 */
const SLUG_OVERRIDES = {};

/** build.nvidia.com answers 200 with a generic page for an unknown slug; only model pages carry this. */
const MODEL_PAGE_MARKER = '"isDeprecated":';
const NOTICE_PATTERN =
  /"deprecationNotice":"This API will be deprecated on (\d{1,2})\/(\d{1,2})\/(\d{4})/;
const ATTRIBUTE_PATTERN = /"key":"DEPRECATION","value":"(\d{1,2})\/(\d{1,2})\/(\d{4})"/;
const IS_DEPRECATED_PATTERN = /"isDeprecated":true/;

function assertCompiledCatalogIsFresh() {
  let sourceStat;
  let compiledStat;
  try {
    sourceStat = statSync(catalogSourcePath);
    compiledStat = statSync(compiledCatalogPath);
  } catch {
    throw new Error(
      `Could not stat ${path.relative(projectRoot, compiledCatalogPath)} or its source. ` +
        "Run `npm run compile` first.",
    );
  }
  if (sourceStat.mtimeMs > compiledStat.mtimeMs) {
    throw new Error(
      `${path.relative(projectRoot, catalogSourcePath)} is newer than the compiled catalog. ` +
        "Run `npm run compile` first.",
    );
  }
}

/** Consume the same module the extension ships instead of scraping TypeScript source. */
function loadModelList() {
  assertCompiledCatalogIsFresh();
  const require = createRequire(import.meta.url);
  const { MODEL_LIST } = require(compiledCatalogPath);
  if (!MODEL_LIST || Object.keys(MODEL_LIST).length === 0) {
    throw new Error("Compiled MODEL_LIST is empty; catalog format changed?");
  }
  return MODEL_LIST;
}

function candidateSlugs(id) {
  const slugs = [SLUG_OVERRIDES[id], id, id.replace(/\./g, "-")].filter(Boolean);
  return [...new Set(slugs)];
}

async function fetchText(url, retries = 3, delayMs = 2000) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "text/html" },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      return await res.text();
    } catch (err) {
      if (attempt >= retries) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function toIsoDate(match) {
  if (!match) {
    return undefined;
  }
  const [, month, day, year] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/** Finds the model page and reads its retirement date; `error` is set when no page could be read. */
async function readNvidiaDate(id) {
  const errors = [];
  for (const slug of candidateSlugs(id)) {
    const url = `${BUILD_URL}/${slug}`;
    let html;
    try {
      html = await fetchText(url);
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    // Page data is embedded as escaped JSON inside script tags.
    const text = html.replace(/\\"/g, '"');
    if (!text.includes(MODEL_PAGE_MARKER)) {
      errors.push(`${url}: not a model page`);
      continue;
    }
    const noticeDate = toIsoDate(NOTICE_PATTERN.exec(text));
    const attributeDate = toIsoDate(ATTRIBUTE_PATTERN.exec(text));
    return {
      url,
      date: noticeDate ?? attributeDate,
      conflict:
        noticeDate && attributeDate && noticeDate !== attributeDate
          ? `notice says ${noticeDate}, endpoint attribute says ${attributeDate}`
          : undefined,
      isDeprecated: IS_DEPRECATED_PATTERN.test(text),
    };
  }
  return { error: errors.join("; ") };
}

function classify(id, catalogDate, page) {
  if (page.error) {
    return { id, status: "unreachable", detail: page.error };
  }
  const detail = [page.conflict, page.isDeprecated ? "page marks the model as deprecated" : ""]
    .filter(Boolean)
    .join("; ");
  if (page.date === catalogDate) {
    return { id, status: "ok", nvidiaDate: page.date, catalogDate, url: page.url, detail };
  }
  const status =
    catalogDate === undefined ? "missing" : page.date === undefined ? "no-nvidia-date" : "differs";
  return { id, status, nvidiaDate: page.date, catalogDate, url: page.url, detail };
}

const STATUS_TEXT = {
  ok: "matches",
  missing: "NVIDIA announced a date the catalog lacks",
  differs: "dates differ",
  "no-nvidia-date": "catalog has a date NVIDIA no longer shows",
  unreachable: "page could not be read",
};

function buildReport(results) {
  const mismatches = results.filter((r) => r.status !== "ok" && r.status !== "unreachable");
  const unreachable = results.filter((r) => r.status === "unreachable");
  const lines = [
    "## NVIDIA NIM retirement dates out of sync",
    "",
    "build.nvidia.com shows retirement dates that do not match `deprecationDate` in `src/models/catalog.ts`. " +
      "Update the catalog so the model picker countdown is right.",
    "",
    "| Model ID | NVIDIA | Catalog | Status |",
    "| :--- | :--- | :--- | :--- |",
  ];
  for (const r of mismatches) {
    const status = [STATUS_TEXT[r.status], r.detail].filter(Boolean).join("; ");
    lines.push(
      `| [\`${r.id}\`](${r.url}) | ${r.nvidiaDate ?? "none"} | ${r.catalogDate ?? "none"} | ${status} |`,
    );
  }
  lines.push("");
  if (unreachable.length > 0) {
    lines.push(`### Not checked (${unreachable.length})`, "");
    for (const r of unreachable) {
      lines.push(`- \`${r.id}\`: ${r.detail}`);
    }
    lines.push("");
  }
  lines.push(
    "---",
    `*Generated on ${new Date().toISOString()} by [track-models.yml](https://github.com/BaUka0/nvidia-nim-provider/actions/workflows/track-models.yml).*`,
    "",
  );
  return lines.join("\n");
}

function setGithubOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`, "utf8");
  }
}

async function main() {
  const reportIndex = process.argv.indexOf("--report");
  const reportPath = reportIndex !== -1 ? process.argv[reportIndex + 1] : undefined;
  if (reportIndex !== -1 && !reportPath) {
    throw new Error("--report needs a file path");
  }

  const modelList = loadModelList();
  const results = [];
  for (const [id, entry] of Object.entries(modelList)) {
    results.push(classify(id, entry.deprecationDate, await readNvidiaDate(id)));
  }

  for (const r of results) {
    const dates =
      r.status === "unreachable"
        ? ""
        : ` (NVIDIA ${r.nvidiaDate ?? "none"}, catalog ${r.catalogDate ?? "none"})`;
    const detail = r.detail ? `: ${r.detail}` : "";
    console.log(`${r.status.padEnd(14)} ${r.id}${dates}${detail}`);
    if (r.status === "unreachable" && process.env.GITHUB_ACTIONS) {
      console.log(`::warning title=Deprecation check skipped ${r.id}::${r.detail}`);
    }
  }

  const mismatches = results.filter((r) => r.status !== "ok" && r.status !== "unreachable");
  setGithubOutput("has_mismatch", mismatches.length > 0 ? "true" : "false");
  if (mismatches.length === 0) {
    console.log("Retirement dates match build.nvidia.com.");
    return;
  }
  if (reportPath) {
    writeFileSync(path.resolve(reportPath), buildReport(results), "utf8");
    console.log(`Report written to ${reportPath}`);
  }
  console.error(`${mismatches.length} model(s) out of sync with build.nvidia.com.`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error("Deprecation check failed:", err instanceof Error ? err.message : err);
  process.exitCode = 2;
});
