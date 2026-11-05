import { actPage } from './act.js'
import { execScript, grantSite } from './grant.js'
import { readLogs, readPage, readScreenshot } from './read.js'
import type { ToolDef } from './types.js'

export type AnyToolDef = ToolDef<any>

/** Every tool prowl registers. Keep the list short: each tool costs prompt tokens on every request. */
export function allTools(): AnyToolDef[] {
  return [readPage, readLogs, readScreenshot, actPage, grantSite, execScript]
}
