import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium, type BrowserContext, type BrowserType, type Dialog, type Page, type Request, type Response } from 'playwright-core'
import { quietFor, REF_ATTR, watchMutations } from './inpage.js'
import type { Sites } from './sites.js'

/** Something the user would want to hear about: a console error, a failed request, a blocked page. */
export interface Note {
  seq: number
  text: string
}

export interface NetEntry {
  id: number
  seq: number
  method: string
  url: string
  type: string
  started: number
  status?: number
  failure?: string
  ms?: number
  request: Request
  response?: Response
}

interface Tab {
  page: Page
  problems: Note[]
  net: NetEntry[]
  /** Document, fetch and XHR requests still running, for `settle`. */
  inflight: number
  /** `seq` when the main frame last navigated. */
  navigated: number
}

export interface BrowserOptions {
  /** Profile folder kept between sessions; undefined runs in memory. */
  profileDir?: string | undefined
  headed: boolean
  /** Extra Chromium arguments (tests map test hosts to 127.0.0.1). */
  args?: string[]
}

const VIEWPORT = { width: 1280, height: 800 }
const KEEP_PROBLEMS = 200
const KEEP_REQUESTS = 500
/** Request failures that are not the site's fault: our own block, or a load the page cancelled. */
const QUIET_FAILURES = /ERR_BLOCKED_BY_CLIENT|ERR_ABORTED|NS_BINDING_ABORTED/
/** Holds the pid of the prowl process using a profile folder. */
const LOCK_FILE = 'prowl.lock'

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0]!

/**
 * One browser for the session, started on first use. Every top-level page
 * load goes through `sites`: a site not allowed is never loaded.
 */
export class Browser {
  #seq = 0
  #netId = 0
  #context: BrowserContext | undefined
  #starting: Promise<BrowserContext> | undefined
  readonly #tabs = new Map<Page, Tab>()
  #current: Page | undefined
  #events: Note[] = []
  #dialog: { accept: boolean; text?: string | undefined } | undefined
  /** The profile lock this process holds, removed on close. */
  #lock: string | undefined
  /** Said in every answer header, e.g. when the profile was in use. */
  notice: string | undefined

  constructor(
    readonly sites: Sites,
    readonly options: BrowserOptions,
    readonly type: BrowserType = chromium,
  ) {}

  get started(): boolean {
    return this.#context !== undefined
  }

  get seq(): number {
    return this.#seq
  }

  #next(): number {
    return ++this.#seq
  }

  #event(text: string): void {
    this.#events.push({ seq: this.#next(), text })
    if (this.#events.length > KEEP_PROBLEMS) this.#events.shift()
  }

  /** Blocked pages, new tabs and dialogs after `since`. */
  eventsSince(since: number): string[] {
    return this.#events.filter((e) => e.seq > since).map((e) => e.text)
  }

  /** Console errors, page errors and failed requests of every tab after `since`. */
  problemsSince(since: number): string[] {
    return [...this.#tabs.values()].flatMap((t) => t.problems).filter((p) => p.seq > since).sort((a, b) => a.seq - b.seq).map((p) => p.text)
  }

  tab(page: Page): Tab | undefined {
    return this.#tabs.get(page)
  }

  get pages(): Page[] {
    return [...this.#tabs.keys()]
  }

  /** The current tab, starting the browser or opening a tab when needed. */
  async page(): Promise<Page> {
    const context = await this.#ensure()
    if (this.#current && !this.#current.isClosed()) return this.#current
    this.#current = this.pages.at(-1) ?? (await context.newPage())
    return this.#current
  }

  switchTo(index: number): Page {
    const page = this.pages[index]
    if (!page) throw new Error(`no tab ${index}; tabs are 0–${this.pages.length - 1}`)
    this.#current = page
    return page
  }

  /** How the next JavaScript dialog (confirm, prompt, beforeunload) is answered. */
  answerNextDialog(accept: boolean, text?: string): void {
    this.#dialog = { accept, text }
  }

  #ensure(): Promise<BrowserContext> {
    if (this.#context) return Promise.resolve(this.#context)
    this.#starting ??= this.#start().finally(() => {
      this.#starting = undefined
    })
    return this.#starting
  }

  async #start(): Promise<BrowserContext> {
    const options = { headless: !this.options.headed, args: this.options.args ?? [], viewport: VIEWPORT, serviceWorkers: 'block' as const, acceptDownloads: false }
    const inMemory = async () => (await this.type.launch(options)).newContext(options)
    const shared = 'Another prowl session is using the browser profile, so this one runs in a fresh profile without its logins.'
    const profileDir = this.options.profileDir
    let context: BrowserContext
    try {
      // Chromium does not always refuse a profile another browser has open; two at once can corrupt it.
      if (profileDir && (await lockProfile(profileDir))) {
        this.#lock = join(profileDir, LOCK_FILE)
        context = await this.type.launchPersistentContext(profileDir, options)
      } else {
        if (profileDir) this.notice = shared
        context = await inMemory()
      }
    } catch (error) {
      const message = errorText(error)
      if (/executable doesn't exist|please run the following command/i.test(message)) {
        throw new Error('Chromium is not installed for prowl. Run `npx -y @redfoxxo/prowl@latest install`, then try again.')
      }
      if (!profileDir || !/ProcessSingleton|SingletonLock|already in use|profile.*in use/i.test(message)) throw error
      context = await inMemory()
      this.notice = shared
    }
    await context.addInitScript(watchMutations, REF_ATTR)
    await context.route('**/*', async (route, request) => {
      let topLevel = false
      if (request.isNavigationRequest()) {
        try {
          topLevel = request.frame().parentFrame() === null
        } catch {
          // A popup's first load comes before its frame exists: it is a top-level page.
          topLevel = true
        }
      }
      const verdict = topLevel ? this.sites.check(request.url()) : { ok: true as const }
      try {
        if (!verdict.ok) {
          this.#event(blockedText(request.url(), verdict))
          await route.abort('blockedbyclient')
        } else await route.continue()
      } catch {
        // The page closed while the request was held.
      }
    })
    context.on('page', (page) => {
      const opened = this.#tabs.size > 0
      this.#attach(page)
      this.#current = page
      if (!opened) return
      this.#event(`new tab ${this.pages.length - 1} opened and is now current (tab 0 is the first)`)
      // A popup whose first page was blocked would stay an empty error tab: close it.
      void page
        .waitForLoadState('domcontentloaded', { timeout: 5000 })
        .then(async () => {
          if (!page.url().startsWith('chrome-error:') || !(await page.opener())) return
          await page.close()
          this.#event('that tab was closed; the page that opened it is current again')
        })
        .catch(() => undefined)
    })
    for (const page of context.pages()) this.#attach(page)
    this.#current = context.pages()[0]
    this.#context = context
    return context
  }

  /**
   * Chromium follows redirects inside its network stack, where `route` never
   * sees them. Intercepting the page's document requests through CDP pauses
   * every hop, so a redirect to a site that is not allowed is stopped before
   * it is requested. Iframes are left alone (see CLAUDE.md).
   */
  async #guardRedirects(page: Page): Promise<void> {
    try {
      const cdp = await page.context().newCDPSession(page)
      const tree = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } }
      const main = tree.frameTree.frame.id
      cdp.on('Fetch.requestPaused', (event: { requestId: string; frameId: string; request: { url: string } }) => {
        const verdict = event.frameId === main ? this.sites.check(event.request.url) : { ok: true as const }
        if (!verdict.ok) this.#event(blockedText(event.request.url, verdict))
        const next = verdict.ok
          ? cdp.send('Fetch.continueRequest', { requestId: event.requestId })
          : cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' })
        next.catch(() => undefined)
      })
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] })
    } catch {
      // The tab closed before the guard was set up; route still checks its first load.
    }
  }

  #attach(page: Page): void {
    if (this.#tabs.has(page)) return
    const tab: Tab = { page, problems: [], net: [], inflight: 0, navigated: this.#seq }
    this.#tabs.set(page, tab)
    void this.#guardRedirects(page)
    const problem = (text: string) => {
      tab.problems.push({ seq: this.#next(), text: text.length > 500 ? `${text.slice(0, 499)}…` : text })
      if (tab.problems.length > KEEP_PROBLEMS) tab.problems.shift()
    }
    const entries = new WeakMap<Request, NetEntry>()
    const counted = (r: Request) => ['document', 'fetch', 'xhr'].includes(r.resourceType())
    const finish = (r: Request) => {
      const entry = entries.get(r)
      if (entry && entry.ms === undefined) {
        entry.ms = Date.now() - entry.started
        if (counted(r)) tab.inflight = Math.max(0, tab.inflight - 1)
      }
      return entry
    }
    page.on('console', (m) => {
      // Chromium logs every failed request again as "Failed to load resource"; the request line already says it.
      if ((m.type() === 'error' || m.type() === 'warning') && !m.text().startsWith('Failed to load resource')) problem(`console ${m.type()}: ${m.text()}`)
    })
    page.on('pageerror', (e) => problem(`page error: ${e.message}`))
    page.on('request', (r) => {
      const entry: NetEntry = { id: ++this.#netId, seq: this.#next(), method: r.method(), url: r.url(), type: r.resourceType(), started: Date.now(), request: r }
      entries.set(r, entry)
      tab.net.push(entry)
      if (tab.net.length > KEEP_REQUESTS) tab.net.shift()
      if (counted(r)) tab.inflight++
    })
    page.on('response', (response) => {
      const entry = entries.get(response.request())
      if (!entry) return
      entry.status = response.status()
      entry.response = response
      if (entry.status >= 400) problem(`${entry.method} ${shortUrl(entry.url, page.url())} → ${entry.status} (request #${entry.id})`)
    })
    page.on('requestfinished', finish)
    page.on('requestfailed', (r) => {
      const entry = finish(r)
      const failure = r.failure()?.errorText ?? 'failed'
      if (entry) entry.failure = failure
      if (!QUIET_FAILURES.test(failure)) problem(`${r.method()} ${shortUrl(r.url(), page.url())} failed: ${failure}${entry ? ` (request #${entry.id})` : ''}`)
    })
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return
      tab.navigated = this.#next()
      // Every load is checked in the route above; this catches a page that got here some other way.
      const verdict = this.sites.check(frame.url())
      if (!verdict.ok && !frame.url().startsWith('chrome-error:')) {
        this.#event(blockedText(frame.url(), verdict))
        void page.goto('about:blank').catch(() => undefined)
      }
    })
    page.on('dialog', (d) => void this.#answer(d))
    page.on('close', () => {
      this.#tabs.delete(page)
      if (this.#current === page) this.#current = this.pages.at(-1)
    })
  }

  async #answer(dialog: Dialog): Promise<void> {
    const choice = this.#dialog
    this.#dialog = undefined
    // Alerts only have OK. Anything that asks is refused unless an act_page step said otherwise.
    const accept = dialog.type() === 'alert' || (choice?.accept ?? false)
    const shown = `${dialog.type()} dialog "${dialog.message().slice(0, 200)}"`
    this.#event(
      accept
        ? `${shown} accepted`
        : `${shown} dismissed; to accept it, put {"do":"dialog","accept":true} before the step that opens it`,
    )
    try {
      if (accept) await dialog.accept(choice?.text)
      else await dialog.dismiss()
    } catch {
      // Already handled or the page closed.
    }
  }

  /** Waits until the page stops loading and changing (at most `maxMs`). */
  async settle(page: Page, maxMs = 5000): Promise<void> {
    // An error page (a blocked or failed load) has nothing left to wait for.
    if (page.url().startsWith('chrome-error:')) return
    const end = Date.now() + maxMs
    await page.waitForLoadState('domcontentloaded', { timeout: maxMs }).catch(() => undefined)
    while (Date.now() < end && !page.isClosed()) {
      const tab = this.#tabs.get(page)
      const quiet = await page.evaluate(quietFor).catch(() => 0)
      if ((tab?.inflight ?? 0) === 0 && quiet >= 250) return
      await sleep(100)
    }
  }

  async close(): Promise<void> {
    const context = this.#context
    this.#context = undefined
    if (!context) return
    // A persistent profile has no separate browser; an in-memory one does.
    const browser = context.browser()
    await context.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
    if (this.#lock) await rm(this.#lock, { force: true })
    this.#lock = undefined
  }
}

/** Takes a profile folder for this process; false when a running prowl process holds it. */
async function lockProfile(dir: string): Promise<boolean> {
  await mkdir(dir, { recursive: true })
  const file = join(dir, LOCK_FILE)
  try {
    await writeFile(file, String(process.pid), { flag: 'wx' })
    return true
  } catch {
    const pid = Number((await readFile(file, 'utf8').catch(() => '')).trim())
    if (pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0)
        return false
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return false
      }
    }
    // The process that held it is gone (a crash): take the profile over.
    await writeFile(file, String(process.pid))
    return true
  }
}

function blockedText(url: string, verdict: { host?: string; reason: string }): string {
  return verdict.host
    ? `blocked ${url}: ${verdict.reason}. Ask the user; only if they agree, call grant_site with "${verdict.host}"`
    : `blocked ${url}: ${verdict.reason}`
}

/** A URL on the page's own origin as its path; others in full. Capped for one line. */
export function shortUrl(url: string, base: string): string {
  let shown = url
  try {
    const u = new URL(url)
    if (u.origin === new URL(base).origin) shown = u.pathname + u.search
  } catch {
    // Keep it as it is.
  }
  return shown.length > 150 ? `${shown.slice(0, 149)}…` : shown
}
