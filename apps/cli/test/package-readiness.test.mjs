import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(".");

test("workspace packages pass release readiness checks", () => {
  execFileSync(process.execPath, ["scripts/check-package-readiness.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
});

test("workspace packages install and run from packed tarballs", () => {
  execFileSync(process.execPath, ["scripts/check-packed-install.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
});
