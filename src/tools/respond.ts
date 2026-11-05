import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Page } from 'playwright-core'
import { z } from 'zod'
import { pageSnapshot, REF_ATTR } from '../browser/inpage.js'
import { errorText } from '../browser/session.js'
import type { ToolContext } from './types.js'

export function text(body: string): CallToolResult {
  return { content: [{ type: 'text', text: body }] }
}

export function failure(body: string): CallToolResult {
  return { content: [{ type: 'text', text: body }], isError: true }
}

export const offsetArg = z.number().int().min(0).optional().describe('Line to start from, when an answer ended with [more: …]')
export const refArg = z.string().regex(/^e\d+$/).describe('Element ref from read_page, e.g. e12')

/** The current tab, if the browser has one on an allowed site; otherwise why not. */
export async function currentPage(ctx: ToolContext): Promise<{ ok: true; page: Page } | { ok: false; error: CallToolResult }> {
  const { browser } = ctx
  if (!browser.started) return { ok: false, error: failure('No page is open yet. Open one with act_page: {"do":"goto","url":"…"}.') }
  const page = await browser.page()
  const verdict = browser.sites.check(page.url())
  if (!verdict.ok && !page.url().startsWith('chrome-error:')) return { ok: false, error: failure(`The current page is not on an allowed site: ${verdict.reason}.`) }
  return { ok: true, page }
}

/** First line of every page answer: where the browser is, and its other tabs. */
export async function header(ctx: ToolContext, page: Page): Promise<string> {
  const title = await page.title().catch(() => '')
  const out = [`${page.url()}${title ? ` · "${title}"` : ''}`]
  const pages = ctx.browser.pages
  if (pages.length > 1) out.push(`tabs: ${pages.map((p, i) => `${i}${p === page ? '*' : ''} ${p.url()}`).join(' · ')}`)
  if (ctx.browser.notice) out.push(`! ${ctx.browser.notice}`)
  return out.join('\n')
}

/** The page as lines (see `pageSnapshot`); retried once when a navigation replaces the document mid-read. */
export async function snapshot(page: Page, scope?: string): Promise<{ lines: string[]; missing?: boolean }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await page.evaluate(pageSnapshot, { refAttr: REF_ATTR, scope })
    } catch (error) {
      if (attempt > 0 || !/context was destroyed|navigat/i.test(errorText(error))) throw error
      await page.waitForLoadState('domcontentloaded').catch(() => undefined)
    }
  }
}
