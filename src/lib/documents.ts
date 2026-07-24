export function splitPinned<T extends { pinned: boolean }>(docs: T[]): { pinned: T[]; rest: T[] } {
  return {
    pinned: docs.filter((d) => d.pinned),
    rest: docs.filter((d) => !d.pinned),
  }
}
