import { resolve } from 'node:path'
import type { Page } from 'playwright-core'
import { z } from 'zod'
import { REF_ATTR } from '../browser/inpage.js'
import { errorText } from '../browser/session.js'
import { isLocalHost } from '../browser/sites.js'
import { diffLines, paginate } from '../format/page.js'
import { UNTRUSTED } from './read.js'
import { header, snapshot, text } from './respond.js'
import { defineTool, type ToolContext } from './types.js'

const ACTIONS = [
  'goto', 'click', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'hover', 'upload', 'scroll', 'wait', 'back', 'forward', 'reload', 'tab', 'close_tab', 'dialog', 'show', 'hide',
] as const

const step = z.object({
  do: z.enum(ACTIONS),
  ref: z.string().regex(/^e\d+$/).optional().describe('Element ref from read_page'),
  url: z.string().optional().describe('goto'),
  value: z
    .string()
    .optional()
    .describe('fill/type: text · select: option label or value · press: key, e.g. Enter, Control+A · wait: text to appear · scroll: up, down, top, bottom · dialog: prompt answer'),
  files: z.array(z.string()).optional().describe('upload: local file paths'),
  ms: z.number().int().min(0).max(30_000).optional().describe('wait: milliseconds, or the timeout for value'),
  index: z.number().int().min(0).optional().describe('tab: tab number'),
  accept: z.boolean().optional().describe('dialog: accept (true) or dismiss the next dialog'),
  double: z.boolean().optional().describe('click: double click'),
})

type Step = z.output<typeof step>

/** Budget for the page printed after a navigation; read_page pages through the rest. */
const NAV_CHARS = 6_000
/** Changes are listed up to this size; beyond it the answer says to read the page. */
const DIFF_CHARS = 4_000

/** A URL to open: scheme added when missing (http for local hosts, https otherwise). */
function target(url: string): string {
  // "localhost:4200" has no scheme; "about:blank" and "https://…" do.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^(about|data|blob|file|javascript|chrome):/i.test(url)) return url
  const host = url.split(/[/:?#]/, 1)[0]!.toLowerCase()
  return `${isLocalHost(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) ? 'http' : 'https'}://${url}`
}

async function element(page: Page, ref: string | undefined, action: string) {
  if (!ref) throw new Error(`${action} needs ref`)
  const found = page.locator(`[${REF_ATTR}="${ref}"]`).first()
  if ((await found.count()) === 0) throw new Error(`${ref} is not on the page any more; call read_page for fresh refs`)
  // Playwright would wait the whole timeout for a disabled control to turn enabled; say it at once.
  if (action !== 'hover' && action !== 'scroll' && (await found.isDisabled().catch(() => false))) {
    throw new Error(`${ref} is disabled; check what the page needs first (read_page)`)
  }
  return found
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`needs ${what}`)
  return value
}

/** Runs one step; returns a short note for the answer, if any. */
async function run(ctx: ToolContext, page: Page, s: Step): Promise<string | void> {
  const timeout = 5_000
  switch (s.do) {
    case 'goto': {
      const url = target(need(s.url, 'url'))
      const verdict = ctx.browser.sites.check(url)
      if (!verdict.ok) {
        throw new Error(
          verdict.host
            ? `${verdict.reason}. Ask the user whether to open ${verdict.host}; only if they agree, call grant_site with "${verdict.host}" and retry`
            : verdict.reason,
        )
      }
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      return
    }
    case 'click':
      return void (await (await element(page, s.ref, 'click')).click({ timeout, clickCount: s.double ? 2 : 1 }))
    case 'fill':
      return void (await (await element(page, s.ref, 'fill')).fill(need(s.value, 'value'), { timeout }))
    case 'type':
      if (s.ref) return void (await (await element(page, s.ref, 'type')).pressSequentially(need(s.value, 'value'), { timeout }))
      return void (await page.keyboard.type(need(s.value, 'value')))
    case 'press':
      if (s.ref) return void (await (await element(page, s.ref, 'press')).press(need(s.value, 'value (a key)'), { timeout }))
      return void (await page.keyboard.press(need(s.value, 'value (a key)')))
    case 'select': {
      const select = await element(page, s.ref, 'select')
      const value = need(s.value, 'value')
      const chosen = await select.selectOption({ label: value }, { timeout: 2000 }).catch(() => select.selectOption(value, { timeout }))
      return chosen.length === 0 ? `no option "${value}"` : undefined
    }
    case 'check':
    case 'uncheck':
      return void (await (await element(page, s.ref, s.do)).setChecked(s.do === 'check', { timeout }))
    case 'hover':
      return void (await (await element(page, s.ref, 'hover')).hover({ timeout }))
    case 'upload': {
      const files = need(s.files, 'files').map((f) => resolve(f))
      return void (await (await element(page, s.ref, 'upload')).setInputFiles(files, { timeout }))
    }
    case 'scroll': {
      if (s.ref) return void (await (await element(page, s.ref, 'scroll')).scrollIntoViewIfNeeded({ timeout }))
      const where = s.value ?? 'down'
      if (!['up', 'down', 'top', 'bottom'].includes(where)) throw new Error('value must be up, down, top or bottom')
      await page.evaluate((w) => {
        if (w === 'top' || w === 'bottom') window.scrollTo(0, w === 'top' ? 0 : document.documentElement.scrollHeight)
        else window.scrollBy(0, (w === 'up' ? -0.8 : 0.8) * window.innerHeight)
      }, where)
      return
    }
    case 'wait':
      if (s.value !== undefined) return void (await page.getByText(s.value).first().waitFor({ state: 'visible', timeout: s.ms ?? timeout }))
      return void (await page.waitForTimeout(need(s.ms, 'value or ms')))
    case 'back':
      return (await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 })) ? undefined : 'no earlier page'
    case 'forward':
      return (await page.goForward({ waitUntil: 'domcontentloaded', timeout: 30_000 })) ? undefined : 'no later page'
    case 'reload':
      return void (await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }))
    case 'tab':
      ctx.browser.switchTo(need(s.index, 'index'))
      return
    case 'close_tab':
      await ctx.browser.closeTab(page)
      return
    case 'dialog':
      ctx.browser.answerNextDialog(s.accept ?? true, s.value)
      return
    case 'show':
    case 'hide':
      await ctx.browser.setHeaded(s.do === 'show')
      return s.do === 'show' ? 'the browser window is open; the user can sign in or look there, then tell you when done' : undefined
  }
}

function label(s: Step): string {
  const detail = s.url ?? (s.ref ? `${s.ref}${s.value !== undefined ? ` "${s.value.slice(0, 40)}"` : ''}` : s.value !== undefined ? `"${s.value.slice(0, 40)}"` : (s.index ?? s.ms ?? ''))
  return `${s.do}${detail === '' ? '' : ` ${detail}`}`
}

export const actPage = defineTool({
  name: 'act_page',
  description:
    'Run steps in the browser, in order, stopping at the first that fails: goto url, click/fill/type/press/select/check/uncheck/hover/upload/scroll ref, wait for text or ms, back, forward, reload, tab index, close_tab, dialog (how to answer the next confirm or prompt; they are dismissed otherwise), show/hide the browser window (show it so the user signs in to a service themselves instead of giving you their password). Local sites (localhost, 127.0.0.1) open freely; any other site only after grant_site. Answers with what changed on the page (or the new page after a navigation), new console errors, failed requests and downloads.',
  input: { steps: z.array(step).min(1).max(30) },
  async handler({ steps }, ctx) {
    const { browser } = ctx
    const start = browser.seq
    let page = await browser.page()
    const before = browser.sites.check(page.url()).ok ? await snapshot(page).catch(() => ({ lines: [] as string[] })) : { lines: [] as string[] }
    const startUrl = page.url()
    const startPage = page
    const results: string[] = []
    for (const [i, s] of steps.entries()) {
      try {
        const note = await run(ctx, page, s)
        results.push(`✓ ${label(s)}${note ? `: ${note}` : ''}`)
      } catch (error) {
        results.push(`✗ ${label(s)}: ${errorText(error).replace(/^\w+\.\w+: /, '')}`)
        if (i < steps.length - 1) results.push(`(${steps.length - 1 - i} later steps not run)`)
        break
      }
      page = await browser.page()
      await browser.settle(page)
    }
    page = await browser.page()
    await browser.settle(page)

    const out = [await header(ctx, page), ...results]
    const events = browser.eventsSince(start)
    if (events.length > 0) out.push(...events.map((e) => `! ${e}`))
    const problems = browser.problemsSince(start)
    if (problems.length > 0) out.push(`problems (${problems.length}):`, ...problems.slice(0, 20).map((p) => `- ${p}`))
    if (problems.length > 20) out.push(`- … ${problems.length - 20} more: read_logs`)

    if (!browser.sites.check(page.url()).ok) return text(out.join('\n'))
    const after = await snapshot(page).catch(() => undefined)
    if (!after) {
      out.push('(the page could not be read; call read_page)')
      return text(out.join('\n'))
    }
    out.push(UNTRUSTED)
    if (page !== startPage || page.url() !== startUrl) {
      out.push('page:', paginate(after.lines, 0, NAV_CHARS, 'read_page offset='))
      return text(out.join('\n'))
    }
    const { added, removed } = diffLines(before.lines, after.lines)
    const changes = [...removed.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`)]
    const size = changes.reduce((n, l) => n + l.length + 1, 0)
    if (changes.length === 0) out.push('no visible change')
    else if (size > DIFF_CHARS) out.push(`the page changed a lot (${added.length} lines added, ${removed.length} removed): call read_page`)
    else out.push('changes:', ...changes)
    return text(out.join('\n'))
  },
})
