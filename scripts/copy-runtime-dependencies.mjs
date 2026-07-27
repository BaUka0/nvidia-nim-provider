import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, "out");
const outputPackageRoot = path.join(outputRoot, "node_modules", "jsonrepair");

const require = createRequire(import.meta.url);
const packageEntry = require.resolve("jsonrepair");
const packageRoot = path.resolve(path.dirname(packageEntry), "..", "..");
const cjsRoot = path.join(packageRoot, "lib", "cjs");

if (!packageEntry.startsWith(packageRoot) || !cjsRoot.startsWith(packageRoot)) {
  throw new Error("Resolved jsonrepair package path is outside its package root");
}

await rm(outputPackageRoot, { recursive: true, force: true });
await mkdir(outputPackageRoot, { recursive: true });

await cp(cjsRoot, path.join(outputPackageRoot, "lib", "cjs"), {
  recursive: true,
  filter: (source) => !source.endsWith(".map"),
});
const packageManifest = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8"),
);
const packageExports = packageManifest.exports?.["."];
const requireEntry =
  typeof packageExports === "string" ? packageExports : packageExports?.require;
const runtimeManifest = {
  name: packageManifest.name,
  version: packageManifest.version,
  type: packageManifest.type,
  main: packageManifest.main,
  ...(typeof requireEntry === "string" ? { exports: { ".": { require: requireEntry } } } : {}),
};
await writeFile(
  path.join(outputPackageRoot, "package.json"),
  `${JSON.stringify(runtimeManifest, null, 2)}\n`,
  "utf8",
);
await cp(path.join(packageRoot, "LICENSE.md"), path.join(outputPackageRoot, "LICENSE.md"));
