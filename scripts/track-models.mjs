import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(__dirname, "models-snapshot.json");
const DIFF_PATH = path.join(__dirname, "models-diff.md");
const API_URL = "https://integrate.api.nvidia.com/v1/models";

async function fetchModelsWithRetry(retries = 3, delayMs = 2000) {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(API_URL, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const data = await res.json();
      if (!Array.isArray(data?.data)) {
        throw new Error("Invalid response format: expected data array");
      }
      return data.data;
    } catch (err) {
      if (i === retries) throw err;
      console.warn(`Fetch attempt ${i} failed: ${err.message}. Retrying in ${delayMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function setGithubOutput(key, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFile(outputFile, `${key}=${value}\n`, "utf8").catch(() => {});
  }
}

async function main() {
  console.log(`Fetching models from ${API_URL}...`);
  const rawModels = await fetchModelsWithRetry();
  console.log(`Fetched ${rawModels.length} models.`);

  const currentModels = rawModels
    .map((m) => ({
      id: m.id,
      owned_by: m.owned_by || m.id.split("/")[0] || "unknown",
      created: m.created || null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  let previousModels = [];
  try {
    const prevContent = await fs.readFile(SNAPSHOT_PATH, "utf8");
    previousModels = JSON.parse(prevContent);
  } catch {
    console.log("No previous snapshot found or unable to parse. Initializing new snapshot.");
  }

  const prevMap = new Map(previousModels.map((m) => [m.id, m]));
  const currentMap = new Map(currentModels.map((m) => [m.id, m]));

  const added = currentModels.filter((m) => !prevMap.has(m.id));
  const removed = previousModels.filter((m) => !currentMap.has(m.id));

  console.log(`Summary: ${added.length} added, ${removed.length} removed.`);

  if (added.length === 0 && removed.length === 0 && previousModels.length > 0) {
    console.log("No changes detected.");
    setGithubOutput("has_changes", "false");
    return;
  }

  // Save new snapshot
  await fs.writeFile(SNAPSHOT_PATH, JSON.stringify(currentModels, null, 2) + "\n", "utf8");
  console.log(`Updated snapshot saved to ${SNAPSHOT_PATH}`);

  if (previousModels.length === 0) {
    console.log("Initial snapshot created without previous history. Skipping diff notification.");
    setGithubOutput("has_changes", "false");
    return;
  }

  // Format markdown report
  const lines = [
    "## NVIDIA NIM Catalog Update Detected",
    "",
    `Automated scan against \`/v1/models\` detected changes in the upstream NGC catalog.`,
    "",
  ];

  if (added.length > 0) {
    lines.push(`### Added Models (${added.length})`);
    lines.push("");
    lines.push("| Model ID | Vendor / Owner |");
    lines.push("| :--- | :--- |");
    for (const m of added) {
      lines.push(`| \`${m.id}\` | ${m.owned_by} |`);
    }
    lines.push("");
  }

  if (removed.length > 0) {
    lines.push(`### Removed Models (${removed.length})`);
    lines.push("");
    lines.push("| Model ID | Vendor / Owner |");
    lines.push("| :--- | :--- |");
    for (const m of removed) {
      lines.push(`| \`${m.id}\` | ${m.owned_by} |`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(
    `*Generated on ${new Date().toISOString()} by [track-models.yml](https://github.com/BaUka0/nvidia-nim-provider/actions/workflows/track-models.yml).*`,
  );
  lines.push("");

  const markdownContent = lines.join("\n");
  await fs.writeFile(DIFF_PATH, markdownContent, "utf8");
  console.log(`Diff report written to ${DIFF_PATH}`);

  setGithubOutput("has_changes", "true");
  setGithubOutput("added_count", added.length);
  setGithubOutput("removed_count", removed.length);

  const titleSummary = [];
  if (added.length > 0) titleSummary.push(`+${added.length} added`);
  if (removed.length > 0) titleSummary.push(`-${removed.length} removed`);
  setGithubOutput("title_summary", titleSummary.join(", "));
}

main().catch((err) => {
  console.error("Tracking script failed:", err);
  process.exit(1);
});
