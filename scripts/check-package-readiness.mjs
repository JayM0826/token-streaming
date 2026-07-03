import { access, readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(".");

const packages = [
  {
    name: "@token-streaming/cli",
    directory: "apps/cli",
    bin: ["token-streaming", "ai"],
    library: false
  },
  ...["protocol", "providers", "ai-manifest", "tools", "storage", "core"].map((name) => ({
    name: `@token-streaming/${name}`,
    directory: `packages/${name}`,
    bin: [],
    library: true
  }))
];

const failures = [];

for (const entry of packages) {
  await checkPackage(entry);
}

if (failures.length > 0) {
  console.error("Package readiness check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Package readiness check passed for ${packages.length} packages.`);
}

async function checkPackage(entry) {
  const packageRoot = path.join(repoRoot, entry.directory);
  const manifestPath = path.join(packageRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  expect(manifest.name === entry.name, `${entry.directory}: expected package name ${entry.name}.`);
  expect(manifest.private !== true, `${entry.directory}: package must not be private for release checks.`);
  expect(manifest.type === "module", `${entry.directory}: package type must be module.`);
  expect(Array.isArray(manifest.files) && manifest.files.includes("dist"), `${entry.directory}: files must include dist.`);
  expect(manifest.engines?.node === ">=22", `${entry.directory}: engines.node must be >=22.`);

  await expectFile(path.join(packageRoot, "dist", "index.js"), `${entry.directory}: missing dist/index.js. Run pnpm build.`);
  await expectFile(path.join(packageRoot, "dist", "index.d.ts"), `${entry.directory}: missing dist/index.d.ts. Run pnpm build.`);

  if (entry.library) {
    expect(manifest.main === "dist/index.js", `${entry.directory}: main must point to dist/index.js.`);
    expect(manifest.types === "dist/index.d.ts", `${entry.directory}: types must point to dist/index.d.ts.`);
    expect(manifest.exports?.["."]?.import === "./dist/index.js", `${entry.directory}: exports[.].import must point to ./dist/index.js.`);
    expect(manifest.exports?.["."]?.types === "./dist/index.d.ts", `${entry.directory}: exports[.].types must point to ./dist/index.d.ts.`);
  }

  for (const binName of entry.bin) {
    const binPath = manifest.bin?.[binName];
    expect(binPath === "dist/index.js", `${entry.directory}: bin ${binName} must point to dist/index.js.`);
  }

  if (entry.bin.length > 0) {
    const cliEntrypoint = await readFile(path.join(packageRoot, "dist", "index.js"), "utf8");
    expect(cliEntrypoint.startsWith("#!/usr/bin/env node"), `${entry.directory}: CLI dist entrypoint must keep the node shebang.`);
  }
}

async function expectFile(filePath, message) {
  try {
    await access(filePath);
  } catch {
    failures.push(message);
  }
}

function expect(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}
