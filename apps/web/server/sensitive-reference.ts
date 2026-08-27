const KNOWN_SECRET_PREFIX = /^(?:sk-|rk-|pk-|sess-|token[._:-]|bearer[._:-]|api[_-]?key[._:-]|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|ASIA|AIza)/i;
const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
const OPAQUE_EVIDENCE_PREFIX = /^(?:contract|license|evidence|receipt|agreement|verification|attestation)[._:-]/i;

/**
 * Evidence references are copied into long-lived append-only events, so reject
 * common credential shapes before persistence. A high-entropy opaque identifier
 * remains usable when it carries an explicit evidence-domain prefix.
 */
export function isLikelySecretEvidenceReference(value: string): boolean {
  if (KNOWN_SECRET_PREFIX.test(value) || JWT_SHAPE.test(value)) return true;
  return (
    value.length >= 43 &&
    /^[A-Za-z0-9_-]+$/.test(value) &&
    new Set(value).size >= 16 &&
    !OPAQUE_EVIDENCE_PREFIX.test(value)
  );
}
