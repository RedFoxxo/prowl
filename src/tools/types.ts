import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { z } from 'zod'
import type { Browser } from '../browser/session.js'

/**
 * The prefix of a tool name is its permission tier, and client approval rules
 * are written on it: reads and page actions run freely, `grant_` needs the
 * user's yes, `exec_` is denied by default.
 */
export type Tier = 'read' | 'act' | 'grant' | 'exec'

export const TIERS: readonly Tier[] = ['read', 'act', 'grant', 'exec']

export interface ToolContext {
  browser: Browser
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  description: string
  input: S
  handler: (args: z.output<z.ZodObject<S>>, ctx: ToolContext) => Promise<CallToolResult>
}

/** Keeps the handler's argument type tied to its schema. */
export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def
}

export function tierOf(name: string): Tier | undefined {
  const prefix = name.split('_', 1)[0]
  return TIERS.find((t) => t === prefix)
}
