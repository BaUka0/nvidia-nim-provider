import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogSourcePath = path.join(projectRoot, "src", "models", "catalog.ts");
const compiledCatalogPath = path.join(projectRoot, "out", "models", "catalog.js");
const packageJsonPath = path.join(projectRoot, "package.json");
const probeScriptPath = path.join(projectRoot, "scripts", "nim-models-probe.mjs");
const constantsPath = path.join(projectRoot, "src", "shared", "constants.ts");

const CACHE_VERSION_PATTERN = /export const MODELS_CACHE_VERSION = (\d+);/;
const CATALOG_DIGEST_PATTERN = /export const MODELS_CACHE_CATALOG_DIGEST = "([^"]*)";/;

/**
 * Fail closed when `out/` predates the catalog source: comparing the manifest
 * against a stale build would report success while the real catalog has moved on.
 */
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
        "Run `npm run compile` before syncing or checking.",
    );
  }
}

/** Consume the same module the extension ships instead of scraping TypeScript source. */
function loadCatalog() {
  assertCompiledCatalogIsFresh();
  const require = createRequire(import.meta.url);
  let catalog;
  try {
    catalog = require(compiledCatalogPath);
  } catch (error) {
    throw new Error(
      `Could not load the compiled catalog at ${path.relative(projectRoot, compiledCatalogPath)}. ` +
        `Run \`npm run compile\` first. (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const { MODEL_LIST, FALLBACK_MODEL_ID, FALLBACK_VISION_MODEL_ID, getCatalogDigest } = catalog;
  if (!MODEL_LIST || Object.keys(MODEL_LIST).length === 0) {
    throw new Error("Compiled MODEL_LIST is empty; catalog format changed?");
  }
  for (const [id, entry] of Object.entries(MODEL_LIST)) {
    if (!entry || typeof entry.adapter !== "string" || entry.adapter.length === 0) {
      throw new Error(`Model entry "${id}" has no adapter field; catalog format changed?`);
    }
  }
  if (!MODEL_LIST[FALLBACK_MODEL_ID] || !MODEL_LIST[FALLBACK_VISION_MODEL_ID]) {
    throw new Error("Fallback model id is not in MODEL_LIST; catalog and defaults diverged.");
  }
  if (typeof getCatalogDigest !== "function") {
    throw new Error("Compiled catalog does not export getCatalogDigest(); run `npm run compile`.");
  }

  return {
    modelList: MODEL_LIST,
    fallbackModelId: FALLBACK_MODEL_ID,
    fallbackVisionModelId: FALLBACK_VISION_MODEL_ID,
    digest: getCatalogDigest(),
  };
}

/**
 * Read a file as LF text while remembering its line ending, so a Windows
 * checkout (CRLF) is never reported as out of sync purely because of EOLs.
 */
function readTracked(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  return { raw, eol, text: raw.replace(/\r\n/g, "\n") };
}

function withOriginalEol(text, eol) {
  return eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export async function syncManifest(options = {}) {
  const isCheck = options.check || process.argv.includes("--check");
  const { modelList, fallbackModelId, fallbackVisionModelId, digest } = loadCatalog();

  const catalogIds = Object.keys(modelList).sort();
  const visionIds = catalogIds.filter((id) => modelList[id].supportsVision).sort();

  // 1. Sync package.json model enums and defaults.
  const pkgFile = readTracked(packageJsonPath);
  const pkg = JSON.parse(pkgFile.text);
  const props = pkg?.contributes?.configuration?.properties;
  if (!props) {
    throw new Error("Invalid package.json structure: missing contributes.configuration.properties");
  }

  const updateProp = (pathObj, key, value) => {
    if (JSON.stringify(pathObj[key]) !== JSON.stringify(value)) {
      pathObj[key] = value;
    }
  };

  if (props["nvidia-nim.fallback.model"]) {
    updateProp(props["nvidia-nim.fallback.model"], "enum", catalogIds);
    updateProp(props["nvidia-nim.fallback.model"], "default", fallbackModelId);
  }
  if (props["nvidia-nim.fallback.priorityList"]?.items) {
    updateProp(props["nvidia-nim.fallback.priorityList"].items, "enum", catalogIds);
  }
  if (props["nvidia-nim.context.summarizationModel"]) {
    updateProp(props["nvidia-nim.context.summarizationModel"], "enum", catalogIds);
    updateProp(props["nvidia-nim.context.summarizationModel"], "default", fallbackModelId);
  }
  if (props["nvidia-nim.fallback.visionModel"]) {
    updateProp(props["nvidia-nim.fallback.visionModel"], "enum", visionIds);
    updateProp(props["nvidia-nim.fallback.visionModel"], "default", fallbackVisionModelId);
  }

  const updatedPkg = withOriginalEol(JSON.stringify(pkg, null, 2) + "\n", pkgFile.eol);
  const pkgModified = updatedPkg !== pkgFile.raw;

  // 2. Sync nim-models-probe.mjs CURATED_MODEL_IDS.
  const probeFile = readTracked(probeScriptPath);
  const probeIdsFormatted = catalogIds.map((id) => `  "${id}",`).join("\n");
  const expectedProbeBlock = `const CURATED_MODEL_IDS = new Set([\n${probeIdsFormatted}\n]);`;
  const updatedProbe = withOriginalEol(
    probeFile.text.replace(
      /const CURATED_MODEL_IDS = new Set\(\[[\s\S]*?\]\);/,
      expectedProbeBlock,
    ),
    probeFile.eol,
  );
  const probeModified = updatedProbe !== probeFile.raw;

  // 3. Sync the recorded catalog digest and bump the model cache version.
  //    Cached model lists are normalized against MODEL_LIST at fetch time, so a
  //    catalog edit leaves them stale until the version changes.
  const constantsFile = readTracked(constantsPath);
  const versionMatch = constantsFile.text.match(CACHE_VERSION_PATTERN);
  const digestMatch = constantsFile.text.match(CATALOG_DIGEST_PATTERN);
  if (!versionMatch || !digestMatch) {
    throw new Error(
      "Could not locate MODELS_CACHE_VERSION / MODELS_CACHE_CATALOG_DIGEST in src/shared/constants.ts.",
    );
  }
  const digestChanged = digestMatch[1] !== digest;
  const nextCacheVersion = digestChanged ? Number(versionMatch[1]) + 1 : Number(versionMatch[1]);
  const updatedConstantsText = digestChanged
    ? constantsFile.text
        .replace(CACHE_VERSION_PATTERN, `export const MODELS_CACHE_VERSION = ${nextCacheVersion};`)
        .replace(CATALOG_DIGEST_PATTERN, `export const MODELS_CACHE_CATALOG_DIGEST = "${digest}";`)
    : constantsFile.text;
  const updatedConstants = withOriginalEol(updatedConstantsText, constantsFile.eol);
  const constantsModified = updatedConstants !== constantsFile.raw;

  if (isCheck) {
    const stale = [];
    if (pkgModified) stale.push("package.json model enums/defaults");
    if (probeModified) stale.push("scripts/nim-models-probe.mjs CURATED_MODEL_IDS");
    if (constantsModified) stale.push("src/shared/constants.ts model cache version/digest");
    if (stale.length > 0) {
      console.error(
        `Out of sync with MODEL_LIST in src/models/catalog.ts: ${stale.join(", ")}. ` +
          "Run `npm run sync:manifest` to update.",
      );
      process.exit(1);
    }
    console.log("Manifest, probe script and model cache version are in sync with MODEL_LIST.");
    return;
  }

  if (pkgModified) {
    writeFileSync(packageJsonPath, updatedPkg, "utf8");
    console.log("Updated package.json model enums and defaults.");
  }
  if (probeModified) {
    writeFileSync(probeScriptPath, updatedProbe, "utf8");
    console.log("Updated scripts/nim-models-probe.mjs CURATED_MODEL_IDS.");
  }
  if (constantsModified) {
    writeFileSync(constantsPath, updatedConstants, "utf8");
    console.log(
      `Updated model cache digest and bumped MODELS_CACHE_VERSION to ${nextCacheVersion}.`,
    );
  }

  if (!pkgModified && !probeModified && !constantsModified) {
    console.log("Manifest, probe script and model cache version are already up to date.");
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  await syncManifest();
}
