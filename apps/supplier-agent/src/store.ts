import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateSupplierAgentProfile, type SupplierAgentPaths } from "./profile.js";
import type { EncryptedSupplierAgentVault, SupplierAgentProfile } from "./types.js";

export class SupplierAgentStore {
  constructor(readonly paths: SupplierAgentPaths) {}

  async exists(): Promise<boolean> {
    return await fileExists(this.paths.profile) && await fileExists(this.paths.vault);
  }

  async readProfile(): Promise<SupplierAgentProfile> {
    return validateSupplierAgentProfile(await readJson(this.paths.profile));
  }

  async readVault(): Promise<EncryptedSupplierAgentVault> {
    return await readJson(this.paths.vault) as EncryptedSupplierAgentVault;
  }

  async write(profile: SupplierAgentProfile, vault: EncryptedSupplierAgentVault): Promise<void> {
    await mkdir(this.paths.root, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(this.paths.profile, profile);
    await writeJsonAtomic(this.paths.vault, vault);
  }
}

async function readJson(filePath: string): Promise<unknown> {
  const raw = await readFile(filePath, "utf8");
  if (Buffer.byteLength(raw, "utf8") > 128 * 1024) throw new Error("Supplier Agent configuration file is too large.");
  return JSON.parse(raw) as unknown;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600).catch(() => undefined);
  await rename(temporary, filePath);
  await chmod(filePath, 0o600).catch(() => undefined);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}
