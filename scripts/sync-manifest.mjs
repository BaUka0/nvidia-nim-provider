import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogTsPath = path.join(projectRoot, "src", "models", "catalog.ts");
const packageJsonPath = path.join(projectRoot, "package.json");
const probeScriptPath = path.join(projectRoot, "scripts", "nim-models-probe.mjs");

async function loadCatalog() {
  const src = readFileSync(catalogTsPath, "utf8");
  const modelListMatch = src.match(/export const MODEL_LIST[^{]*=([\s\S]*?\n\};)/);
  if (!modelListMatch) {
    throw new Error("Could not locate MODEL_LIST in src/models/catalog.ts");
  }

  const modelEntries = [...modelListMatch[1].matchAll(/"([^"]+)":\s*\{([\s\S]*?)\n\s*\},/g)];
  if (modelEntries.length === 0) {
    throw new Error("Parsed zero model entries from MODEL_LIST; catalog format changed?");
  }
  const modelList = {};
  for (const [, id, block] of modelEntries) {
    const supportsVision = /supportsVision:\s*true/.test(block);
    if (!/adapter:\s*"[^"]+"/.test(block)) {
      throw new Error(`Model entry "${id}" has no adapter field; catalog format changed?`);
    }
    modelList[id] = { supportsVision };
  }

  const fbMatch = src.match(/export const FALLBACK_MODEL_ID\s*=\s*"([^"]+)";/);
  const fbVisionMatch = src.match(/export const FALLBACK_VISION_MODEL_ID\s*=\s*"([^"]+)";/);
  if (!fbMatch || !fbVisionMatch) {
    throw new Error("Could not locate FALLBACK_MODEL_ID in src/models/catalog.ts");
  }
  if (!modelList[fbMatch[1]] || !modelList[fbVisionMatch[1]]) {
    throw new Error("Fallback model id is not in MODEL_LIST; catalog and defaults diverged.");
  }

  return {
    modelList,
    fallbackModelId: fbMatch[1],
    fallbackVisionModelId: fbVisionMatch[1],
  };
}

export async function syncManifest(options = {}) {
  const isCheck = options.check || process.argv.includes("--check");
  const { modelList, fallbackModelId, fallbackVisionModelId } = await loadCatalog();

  const catalogIds = Object.keys(modelList).sort();
  const visionIds = catalogIds.filter((id) => modelList[id].supportsVision).sort();

  let modified = false;

  // 1. Sync package.json
  const rawPkg = readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(rawPkg);
  const props = pkg?.contributes?.configuration?.properties;
  if (!props) {
    throw new Error("Invalid package.json structure: missing contributes.configuration.properties");
  }

  const updateProp = (pathObj, key, value) => {
    const current = JSON.stringify(pathObj[key]);
    const next = JSON.stringify(value);
    if (current !== next) {
      pathObj[key] = value;
      modified = true;
    }
  };

  if (props["nvidia-nim.fallback.model"]) {
    updateProp(props["nvidia-nim.fallback.model"], "enum", catalogIds);
    if (fallbackModelId) {
      updateProp(props["nvidia-nim.fallback.model"], "default", fallbackModelId);
    }
  }

  if (props["nvidia-nim.fallback.priorityList"]?.items) {
    updateProp(props["nvidia-nim.fallback.priorityList"].items, "enum", catalogIds);
  }

  if (props["nvidia-nim.context.summarizationModel"]) {
    updateProp(props["nvidia-nim.context.summarizationModel"], "enum", catalogIds);
    if (fallbackModelId) {
      updateProp(props["nvidia-nim.context.summarizationModel"], "default", fallbackModelId);
    }
  }

  if (props["nvidia-nim.fallback.visionModel"]) {
    updateProp(props["nvidia-nim.fallback.visionModel"], "enum", visionIds);
    if (fallbackVisionModelId) {
      updateProp(props["nvidia-nim.fallback.visionModel"], "default", fallbackVisionModelId);
    }
  }

  const updatedPkg = JSON.stringify(pkg, null, 2) + "\n";

  // 2. Sync nim-models-probe.mjs
  const rawProbe = readFileSync(probeScriptPath, "utf8");
  const probeIdsFormatted = catalogIds.map((id) => `  "${id}",`).join("\n");
  const expectedProbeBlock = `const CURATED_MODEL_IDS = new Set([\n${probeIdsFormatted}\n]);`;
  const updatedProbe = rawProbe.replace(
    /const CURATED_MODEL_IDS = new Set\(\[[\s\S]*?\]\);/,
    expectedProbeBlock,
  );

  const probeModified = rawProbe !== updatedProbe;
  const pkgModified = rawPkg !== updatedPkg;

  if (isCheck) {
    if (pkgModified || probeModified) {
      console.error(
        "Manifest or probe script is out of sync with MODEL_LIST in src/models/catalog.ts. Run `npm run sync:manifest` to update.",
      );
      process.exit(1);
    }
    console.log("Manifest and probe script are in sync with MODEL_LIST.");
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

  if (!pkgModified && !probeModified) {
    console.log("Manifest and probe script are already up to date.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await syncManifest();
}
