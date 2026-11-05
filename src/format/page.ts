/** Characters per answer (~3K tokens). Longer answers are paged, never cut mid-line. */
export const PAGE_CHARS = 12_000

/**
 * Lines from `offset` until the character budget, with a footer telling how
 * to get the rest. A single line longer than the budget is shortened.
 */
export function paginate(lines: string[], offset = 0, limit = PAGE_CHARS, more = 'call again with offset='): string {
  const out: string[] = []
  let used = 0
  let index = offset
  for (; index < lines.length; index++) {
    let line = lines[index]!
    if (line.length > limit) line = `${line.slice(0, limit - 1)}…`
    if (out.length > 0 && used + line.length + 1 > limit) break
    out.push(line)
    used += line.length + 1
  }
  if (index < lines.length) {
    out.push(`[more: lines ${offset + 1}–${index} of ${lines.length} shown; ${more}${index}]`)
  }
  return out.join('\n')
}

/**
 * What changed between two page reads, ignoring order: lines that are new,
 * and lines that are gone. Repeated lines are matched one for one.
 */
export function diffLines(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const left = new Map<string, number>()
  for (const line of before) left.set(line, (left.get(line) ?? 0) + 1)
  const added: string[] = []
  for (const line of after) {
    const n = left.get(line) ?? 0
    if (n > 0) left.set(line, n - 1)
    else added.push(line)
  }
  const removed: string[] = []
  for (const line of before) {
    const n = left.get(line) ?? 0
    if (n > 0) {
      removed.push(line)
      left.set(line, n - 1)
    }
  }
  return { added, removed }
}
