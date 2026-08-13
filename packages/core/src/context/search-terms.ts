const GENERIC_SEARCH_TERMS = new Set([
  "apps",
  "changes",
  "code",
  "files",
  "index",
  "logic",
  "module",
  "modules",
  "must",
  "packages",
  "readme",
  "related",
  "should",
  "src",
  "test",
  "tests",
  "yaml",
  "yml",
  "代码",
  "修改",
  "变更",
  "所有",
  "文件",
  "相关",
  "必须",
  "应该",
  "提供",
  "逻辑",
  "需要"
]);
const GENERIC_HAN_TERMS = [...GENERIC_SEARCH_TERMS]
  .filter((term) => /^\p{Script=Han}+$/u.test(term))
  .sort((left, right) => right.length - left.length);

export function taskTextIncludesSearchTerms(taskText: string, value: string): boolean {
  const normalizedTask = taskText.toLowerCase();
  return extractSearchTerms(value).some((term) => normalizedTask.includes(term));
}

export function extractSearchTerms(value: string): string[] {
  const chunks = value.toLowerCase().match(/\p{Script=Han}+|[\p{L}\p{N}_-]+/gu) ?? [];
  return [
    ...new Set(
      chunks
        .filter((chunk) => !GENERIC_SEARCH_TERMS.has(chunk))
        .flatMap(expandSearchChunk)
        .filter((term) => !GENERIC_SEARCH_TERMS.has(term))
    )
  ];
}

function expandSearchChunk(chunk: string): string[] {
  if (/^\p{Script=Han}+$/u.test(chunk)) {
    return splitGenericHanTerms(chunk).flatMap((fragment) =>
      fragment.length <= 2
        ? [fragment]
        : [fragment, ...Array.from({ length: fragment.length - 1 }, (_, index) => fragment.slice(index, index + 2))]
    );
  }
  if (chunk.length <= 3) {
    return [];
  }
  return [chunk, ...englishStemVariants(chunk)];
}

function splitGenericHanTerms(value: string): string[] {
  let fragments = [value];
  for (const generic of GENERIC_HAN_TERMS) {
    fragments = fragments.flatMap((fragment) => fragment.split(generic));
  }
  return fragments.filter(Boolean);
}

function englishStemVariants(value: string): string[] {
  const variants: string[] = [];
  for (const suffix of ["ations", "ation", "ments", "ment", "ingly", "ing", "edly", "ed"]) {
    if (value.endsWith(suffix) && value.length - suffix.length >= 4) {
      variants.push(value.slice(0, -suffix.length));
    }
  }
  if (value.endsWith("e") && value.length > 5) {
    variants.push(value.slice(0, -1));
  }
  return variants;
}
