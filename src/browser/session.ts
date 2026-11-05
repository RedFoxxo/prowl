import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  chromium,
  type BrowserContext,
  type BrowserContextOptions,
  type BrowserType,
  type CDPSession,
  type Dialog,
  type Download,
  type Page,
  type Request,
  type Response,
} from 'playwright-core'
import { quietFor, REF_ATTR, watchMutations } from './inpage.js'
import type { Sites } from './sites.js'

/** Cookies and local storage, as Playwright saves and restores them. */
type StorageState = Exclude<BrowserContextOptions['storageState'], string | undefined>

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
  /** Where downloads are saved; undefined refuses them. */
  downloadsDir?: string | undefined
  /** Start with the window shown. */
  headed: boolean
  /** Extra Chromium arguments (tests map test hosts to 127.0.0.1). */
  args?: string[]
  /** Downloads Chromium when it is missing; undefined says how to instead. */
  install?: () => Promise<void>
}

const VIEWPORT = { width: 1280, height: 800 }
const KEEP_PROBLEMS = 200
const KEEP_REQUESTS = 500
/** Request failures that are not the site's fault: our own block, or a load the page cancelled. */
const QUIET_FAILURES = /ERR_BLOCKED_BY_CLIENT|ERR_ABORTED|NS_BINDING_ABORTED/
/** Holds the pid of the prowl process using a profile folder. */
const LOCK_FILE = 'prowl.lock'
const MISSING_BROWSER = /executable doesn't exist|please run the following command/i
const NO_SCREEN = 'There is no screen to show the browser on (no DISPLAY or WAYLAND_DISPLAY, e.g. over SSH), so it runs hidden.'
/** Linux needs an X or Wayland display for a window; macOS and Windows always have one. */
const hasScreen = () => process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
const SHARED_PROFILE = 'Another prowl session is using the browser profile, so this one runs in a fresh profile without its logins.'

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0]!

/**
 * One browser for the session, started on first use. Every page and iframe
 * load goes through `sites`: a site not allowed is never requested.
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
  #headed: boolean
  /** Tabs whose redirect guard is on, and the setup of the others. */
  readonly #guarded = new WeakSet<Page>()
  readonly #guarding = new WeakMap<Page, Promise<void>>()
  readonly #cdp = new WeakMap<Page, CDPSession>()
  /** First loads of new tabs, held back until their guard was on. */
  #reopen: { url: string; referer?: string | undefined; at: number }[] = []
  /** New tabs and downloads still being handled, for `settle`. */
  readonly #busy = new Set<Promise<void>>()
  /** When a load for a tab that does not exist yet was seen; cleared when a tab opens. */
  #tabExpected = 0
  /** Cookies and storage carried over when an in-memory browser restarts (show/hide). */
  #carry: StorageState | undefined
  /** Said in every answer header, e.g. when the profile was in use. */
  notice: string | undefined

  constructor(
    readonly sites: Sites,
    readonly options: BrowserOptions,
    readonly type: BrowserType = chromium,
  ) {
    this.#headed = options.headed
  }

  get started(): boolean {
    return this.#context !== undefined
  }

  get headed(): boolean {
    return this.#headed
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

  #track(work: Promise<void>): void {
    const tracked = work.catch(() => undefined).finally(() => this.#busy.delete(tracked))
    this.#busy.add(tracked)
  }

  /** Blocked pages, new tabs, dialogs and downloads after `since`. */
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

  /** The current tab, starting the browser or opening a tab when needed; its guard is on. */
  async page(): Promise<Page> {
    const context = await this.#ensure()
    if (!this.#current || this.#current.isClosed()) {
      this.#current = this.pages.at(-1) ?? (await context.newPage())
      this.#attach(this.#current)
    }
    await this.#guarding.get(this.#current)
    return this.#current
  }

  /** Closes a tab. Its CDP session goes first: a page with request interception on can take seconds to close otherwise. */
  async closeTab(page: Page): Promise<void> {
    await this.#cdp.get(page)?.detach().catch(() => undefined)
    await page.close()
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

  /**
   * Shows or hides the browser window by restarting it, keeping the open tabs
   * and the logins. Without a screen (e.g. over SSH) it stays hidden and says so.
   */
  async setHeaded(headed: boolean): Promise<void> {
    if (headed === this.#headed && this.started) return
    if (headed && !hasScreen()) throw new Error(NO_SCREEN)
    const urls = this.pages.map((p) => p.url()).filter((u) => u !== 'about:blank' && this.sites.check(u).ok)
    const current = this.#current ? Math.max(0, this.pages.indexOf(this.#current)) : 0
    this.#carry = this.started && !this.#lock ? await this.#context!.storageState() : undefined
    await this.close()
    this.#headed = headed
    let failure: Error | undefined
    try {
      await this.#ensure()
    } catch (error) {
      if (!headed) throw error
      // The display is there but Chromium could not open a window on it: go on hidden.
      failure = new Error(`The browser window could not be opened (${errorText(error)}); it keeps running hidden.`)
      this.#headed = false
      await this.#ensure()
    }
    for (const [i, url] of urls.entries()) {
      const page = i === 0 && this.pages[0] ? this.pages[0] : await this.#context!.newPage()
      this.#attach(page)
      await this.#guarding.get(page)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined)
    }
    if (this.pages[current]) this.#current = this.pages[current]
    if (failure) throw failure
  }

  #ensure(): Promise<BrowserContext> {
    if (this.#context) return Promise.resolve(this.#context)
    this.#starting ??= this.#start().finally(() => {
      this.#starting = undefined
    })
    return this.#starting
  }

  async #launch(): Promise<BrowserContext> {
    if (this.#headed && !hasScreen()) {
      this.#headed = false
      this.notice = NO_SCREEN
    }
    const args = [...(this.options.args ?? [])]
    // Chromium needs to be told to use Wayland when there is no X server.
    if (this.#headed && !process.env.DISPLAY && process.env.WAYLAND_DISPLAY) args.push('--ozone-platform=wayland')
    const options = { headless: !this.#headed, args, viewport: VIEWPORT, serviceWorkers: 'block' as const, acceptDownloads: true }
    const inMemory = async () => (await this.type.launch(options)).newContext({ ...options, ...(this.#carry ? { storageState: this.#carry } : {}) })
    const profileDir = this.options.profileDir
    try {
      // Chromium does not always refuse a profile another browser has open; two at once can corrupt it.
      if (profileDir && (await lockProfile(profileDir))) {
        this.#lock = join(profileDir, LOCK_FILE)
        try {
          return await this.type.launchPersistentContext(profileDir, options)
        } catch (error) {
          await rm(this.#lock, { force: true })
          this.#lock = undefined
          throw error
        }
      }
      if (profileDir) this.notice = SHARED_PROFILE
      return await inMemory()
    } catch (error) {
      if (!profileDir || !/ProcessSingleton|SingletonLock|already in use|profile.*in use/i.test(errorText(error))) throw error
      this.notice = SHARED_PROFILE
      return inMemory()
    }
  }

  async #start(): Promise<BrowserContext> {
    let context: BrowserContext
    try {
      context = await this.#launch()
    } catch (error) {
      if (!MISSING_BROWSER.test(errorText(error))) throw error
      if (!this.options.install) throw new Error('Chromium is not installed for prowl. Run `npx -y @redfoxxo/prowl@latest install`, then try again.')
      // First use on this machine: download the browser once, then go on.
      await this.options.install()
      context = await this.#launch()
      this.#event('Chromium was downloaded for prowl (first use on this machine)')
    }
    await context.addInitScript(watchMutations, REF_ATTR)
    await context.route('**/*', async (route, request) => {
      try {
        if (request.isNavigationRequest()) {
          let page: Page | undefined
          let topLevel = true
          try {
            const frame = request.frame()
            topLevel = frame.parentFrame() === null
            page = frame.page()
          } catch {
            // A new tab's first load comes before its frame exists: a top-level page.
            // Its tab shows up a moment later; `settle` waits for it.
            this.#tabExpected = Date.now()
          }
          const verdict = this.sites.check(request.url())
          if (!verdict.ok) {
            this.#event(blockedText(request.url(), verdict, topLevel ? 'page' : 'iframe'))
            await route.abort('blockedbyclient')
            return
          }
          // A new tab's redirect guard is not on yet: hold its first load and make it again once it is.
          if (topLevel && (!page || !this.#guarded.has(page)) && request.method() === 'GET') {
            this.#reopen.push({ url: request.url(), referer: request.headers()['referer'], at: Date.now() })
            // An error page still commits, so the tab appears; a plain abort would make it vanish.
            await route.abort('blockedbyclient')
            return
          }
        }
        await route.continue()
      } catch {
        // The page closed while the request was held.
      }
    })
    context.on('page', (page) => {
      const opened = this.#tabs.size > 0
      this.#attach(page)
      this.#current = page
      if (!opened) return
      this.#tabExpected = 0
      this.#event(`new tab ${this.pages.length - 1} opened and is now current (tab 0 is the first)`)
      this.#track(this.#openTab(page))
    })
    for (const page of context.pages()) this.#attach(page)
    this.#current = context.pages()[0]
    this.#context = context
    return context
  }

  /** A new tab: once its guard is on, makes the load that was held back; closes it if it only shows a blocked page. */
  async #openTab(page: Page): Promise<void> {
    await this.#guarding.get(page)
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined)
    if (page.url() !== 'about:blank' && !page.url().startsWith('chrome-error:')) return
    this.#reopen = this.#reopen.filter((r) => Date.now() - r.at < 10_000)
    const held = this.#reopen.shift()
    // 'commit' returns once the page or its error page is there; settle waits for the rest.
    if (held) await page.goto(held.url, { referer: held.referer, waitUntil: 'commit', timeout: 10_000 }).catch(() => undefined)
    if (page.url().startsWith('chrome-error:') && this.#tabs.size > 1) {
      await this.closeTab(page)
      this.#event('that tab only showed a blocked page and was closed; the page before it is current again')
    }
  }

  /**
   * Chromium follows redirects inside its network stack, where `route` never
   * sees them. Intercepting the tab's document requests through CDP pauses
   * every hop, so a redirect to a site that is not allowed is stopped before
   * it is requested.
   */
  async #guardRedirects(page: Page): Promise<void> {
    try {
      const cdp = await page.context().newCDPSession(page)
      this.#cdp.set(page, cdp)
      const tree = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } }
      const main = tree.frameTree.frame.id
      cdp.on('Fetch.requestPaused', (event: { requestId: string; frameId: string; request: { url: string } }) => {
        const verdict = this.sites.check(event.request.url)
        if (!verdict.ok) this.#event(blockedText(event.request.url, verdict, event.frameId === main ? 'page' : 'iframe'))
        const next = verdict.ok
          ? cdp.send('Fetch.continueRequest', { requestId: event.requestId })
          : cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' })
        next.catch(() => undefined)
      })
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] })
    } catch {
      // The tab closed before the guard was set up.
    } finally {
      this.#guarded.add(page)
    }
  }

  #attach(page: Page): void {
    if (this.#tabs.has(page)) return
    const tab: Tab = { page, problems: [], net: [], inflight: 0, navigated: this.#seq }
    this.#tabs.set(page, tab)
    this.#guarding.set(page, this.#guardRedirects(page))
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
      // Every load is checked before it is requested; this catches a page that got here some other way.
      const verdict = this.sites.check(frame.url())
      if (!verdict.ok && !frame.url().startsWith('chrome-error:')) {
        this.#event(blockedText(frame.url(), verdict, 'page'))
        void page.goto('about:blank').catch(() => undefined)
      }
    })
    page.on('dialog', (d) => void this.#answer(d))
    page.on('download', (d) => this.#track(this.#save(d)))
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

  /** Saves a download under the downloads folder with a name that is not taken yet. */
  async #save(download: Download): Promise<void> {
    const dir = this.options.downloadsDir
    const name = basename(download.suggestedFilename()) || 'download'
    if (!dir) {
      await download.cancel()
      this.#event(`download of ${name} refused (no downloads folder set)`)
      return
    }
    await mkdir(dir, { recursive: true })
    const ext = extname(name)
    let path = join(dir, name)
    for (let n = 1; await access(path).then(() => true, () => false); n++) path = join(dir, `${name.slice(0, name.length - ext.length)} (${n})${ext}`)
    try {
      await download.saveAs(path)
      this.#event(`downloaded ${name} from ${download.url()} to ${path} (${(await stat(path)).size} bytes)`)
    } catch (error) {
      this.#event(`download of ${name} failed: ${download.failure() ?? errorText(error)}`)
    }
  }

  /** Waits until the page stops loading and changing, new tabs are handled and downloads saved (at most `maxMs`). */
  async settle(page: Page, maxMs = 5000): Promise<void> {
    const end = Date.now() + maxMs
    const waitBusy = async () => {
      // A tab that is about to open shows up within a moment; give up on it after 2 s.
      while (this.#tabExpected > 0 && Date.now() - this.#tabExpected < 2000 && Date.now() < end) await sleep(50)
      if (this.#busy.size > 0) await Promise.race([Promise.all(this.#busy), sleep(Math.max(0, end - Date.now()))])
    }
    await waitBusy()
    // An error page (a blocked or failed load) has nothing left to wait for.
    if (!page.isClosed() && !page.url().startsWith('chrome-error:')) {
      await page.waitForLoadState('domcontentloaded', { timeout: Math.max(1, end - Date.now()) }).catch(() => undefined)
      while (Date.now() < end && !page.isClosed()) {
        const tab = this.#tabs.get(page)
        const quiet = await page.evaluate(quietFor).catch(() => 0)
        if ((tab?.inflight ?? 0) === 0 && quiet >= 250) break
        await sleep(100)
      }
    }
    // A click that opens a tab announces it only while the page settles.
    await waitBusy()
  }

  async close(): Promise<void> {
    const context = this.#context
    this.#context = undefined
    this.#tabs.clear()
    this.#current = undefined
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

function blockedText(url: string, verdict: { host?: string; reason: string }, what: 'page' | 'iframe'): string {
  const head = `blocked ${what === 'iframe' ? 'iframe ' : ''}${url}: ${verdict.reason}`
  return verdict.host ? `${head}. Ask the user; only if they agree, call grant_site with "${verdict.host}"` : head
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
