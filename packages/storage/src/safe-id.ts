export function assertSafeStorageId(kind: string, id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid ${kind} id: ${id}`);
  }
}
