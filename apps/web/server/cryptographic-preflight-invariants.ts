export const CRYPTOGRAPHIC_PREFLIGHT_SCHEMA_CAPABILITIES_SQL = `
  SELECT name FROM sqlite_master
  WHERE type = 'table' AND name IN (
    'cryptographic_keyring_states',
    'cryptographic_key_bootstrap_eligibility'
  )`;

export interface CryptographicPreflightSchemaCapabilities {
  keyringStates: boolean;
  bootstrapEligibility: boolean;
}

export function resolveCryptographicPreflightSchemaCapabilities(
  rows: readonly { name: string }[]
): CryptographicPreflightSchemaCapabilities {
  const names = new Set(rows.map((row) => row.name));
  return {
    keyringStates: names.has("cryptographic_keyring_states"),
    bootstrapEligibility: names.has("cryptographic_key_bootstrap_eligibility")
  };
}
