import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Browser } from '../src/browser/session.js'
import { actPage } from '../src/tools/act.js'
import { execScript, grantSite } from '../src/tools/grant.js'
import { readLogs, readPage, readScreenshot } from '../src/tools/read.js'
import { call, startSite, testBrowser, type TestSite } from './fixture.js'

let site: TestSite
let browser: Browser

beforeAll(async () => {
  site = await startSite()
})
afterAll(() => site.close())
afterEach(() => browser?.close())

const ctx = () => ({ browser })
const act = (...steps: Record<string, unknown>[]) => call(actPage, { steps }, ctx())
const refOf = (text: string, line: string) => {
  const found = text.split('\n').find((l) => l.includes(line))
  const ref = found?.match(/\[(e\d+) /)?.[1]
  if (!ref) throw new Error(`no ref for ${line} in:\n${text}`)
  return ref
}

describe('reading a page', () => {
  it('shows headings, controls, lists and tables, and leaves hidden text out', async () => {
    browser = testBrowser()
    const opened = await act({ do: 'goto', url: site.local('/app') })
    expect(opened.isError).toBe(false)
    const { text } = await call(readPage, {}, ctx())
    expect(text).toContain('# Orders')
    expect(text).toMatch(/\[e\d+ textbox "Email"\]/)
    expect(text).toMatch(/\[e\d+ checkbox "I agree" unchecked\]/)
    expect(text).toMatch(/\[e\d+ combobox = "Small" options: Small \| Large\]/)
    expect(text).toContain('- First item')
    expect(text).toContain('Apple | 3')
    expect(text).not.toContain('Secret hidden text')
    expect(text).not.toContain('Also hidden')
  })

  it('keeps an element under the same ref between reads, and never shows a password', async () => {
    browser = testBrowser()
    await act({ do: 'goto', url: site.local('/app') })
    const first = (await call(readPage, {}, ctx())).text
    const pw = refOf(first, 'textbox "Password"')
    await act({ do: 'fill', ref: pw, value: 'hunter2' })
    const second = (await call(readPage, {}, ctx())).text
    expect(refOf(second, 'textbox "Password"')).toBe(pw)
    expect(second).toContain('= "•••"')
    expect(second).not.toContain('hunter2')
  })
})

describe('acting on a page', () => {
  it('answers with what changed, the console error and the failed request', async () => {
    browser = testBrowser()
    const page = (await act({ do: 'goto', url: site.local('/app') })).text
    const { text } = await act({ do: 'click', ref: refOf(page, 'button "Save"') })
    expect(text).toContain('✓ click')
    expect(text).toContain('+ Saved!')
    expect(text).toContain('console error: boom')
    expect(text).toMatch(/POST \/api\/fail → 500 \(request #\d+\)/)
    // Chromium's own "Failed to load resource" console line would say the same thing twice.
    expect(text).not.toContain('Failed to load resource')
    // The full page is not sent again after a small change.
    expect(text).not.toContain('# Orders')
  })

  it('fills, checks and selects in one call', async () => {
    browser = testBrowser()
    const page = (await act({ do: 'goto', url: site.local('/app') })).text
    const { text } = await act(
      { do: 'fill', ref: refOf(page, 'textbox "Email"'), value: 'a@b.c' },
      { do: 'check', ref: refOf(page, 'checkbox "I agree"') },
      { do: 'select', ref: refOf(page, 'combobox'), value: 'Large' },
    )
    expect(text).toMatch(/\+ \[e\d+ textbox "Email" = "a@b.c"\]/)
    expect(text).toMatch(/\+ \[e\d+ checkbox "I agree" checked\]/)
    expect(text).toMatch(/\+ \[e\d+ combobox = "Large"/)
  })

  it('stops at the first failing step and says a stale ref needs a fresh read', async () => {
    browser = testBrowser()
    const page = (await act({ do: 'goto', url: site.local('/rerender') })).text
    const old = refOf(page, 'button "Old"')
    const { text } = await act({ do: 'click', ref: old }, { do: 'click', ref: old }, { do: 'reload' })
    expect(text).toContain(`✗ click ${old}: ${old} is not on the page any more`)
    expect(text).toContain('(1 later steps not run)')
  })

  it('says at once that a disabled control is disabled instead of waiting for it', async () => {
    browser = testBrowser()
    const page = (await act({ do: 'goto', url: site.local('/app') })).text
    const send = refOf(page, 'button "Send" disabled')
    const started = Date.now()
    const { text } = await act({ do: 'click', ref: send })
    expect(text).toContain(`✗ click ${send}: ${send} is disabled`)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('dismisses a confirm unless a dialog step accepts it', async () => {
    browser = testBrowser()
    const page = (await act({ do: 'goto', url: site.local('/app') })).text
    const del = refOf(page, 'button "Delete"')
    const dismissed = (await act({ do: 'click', ref: del })).text
    expect(dismissed).toContain('confirm dialog "Delete everything?" dismissed')
    expect(dismissed).toContain('+ Kept')
    const accepted = (await act({ do: 'dialog', accept: true }, { do: 'click', ref: del })).text
    expect(accepted).toContain('accepted')
    expect(accepted).toContain('+ Deleted')
  })
})

describe('opening pages', () => {
  it('opens a local address typed without a scheme, such as localhost:4200', async () => {
    browser = testBrowser()
    const { text } = await act({ do: 'goto', url: `localhost:${site.port}/app` })
    expect(text).toContain(`http://localhost:${site.port}/app`)
    expect(text).toContain('# Orders')
  })
})

describe('consent for other sites', () => {
  it('refuses another site until it is granted, then allows it and its subdomains', async () => {
    browser = testBrowser()
    const refused = await act({ do: 'goto', url: site.other('site.test', '/page') })
    expect(refused.text).toContain('site.test is not allowed yet')
    expect(refused.text).toContain('grant_site with "site.test"')
    expect(refused.text).not.toContain('External page')

    expect((await call(grantSite, { site: 'site.test' }, ctx())).isError).toBe(false)
    expect((await act({ do: 'goto', url: site.other('site.test', '/page') })).text).toContain('# External page on site.test')
    expect((await act({ do: 'goto', url: site.other('sub.site.test', '/page') })).text).toContain('# External page on sub.site.test')
    expect((await act({ do: 'goto', url: site.other('other.test', '/page') })).text).toContain('other.test is not allowed yet')
  })

  it('blocks links, redirects and popups to a site that is not allowed, before any request reaches it', async () => {
    browser = testBrowser()
    site.requests.length = 0
    const page = (await act({ do: 'goto', url: site.local('/app') })).text

    const link = (await act({ do: 'click', ref: refOf(page, 'link "External"') })).text
    expect(link).toContain('blocked http://site.test')
    expect(link).not.toContain('External page')

    await act({ do: 'goto', url: site.local('/app') })
    const again = (await call(readPage, {}, ctx())).text
    const redirect = (await act({ do: 'click', ref: refOf(again, 'link "Redirect away"') })).text
    expect(redirect).toContain('blocked http://site.test')
    expect(redirect).not.toContain('External page')

    await act({ do: 'goto', url: site.local('/app') })
    const third = (await call(readPage, {}, ctx())).text
    const popup = (await act({ do: 'click', ref: refOf(third, 'button "Popup"') })).text
    expect(popup).toContain('blocked http://site.test')
    expect(popup).not.toContain('External page')
    // The empty tab the popup left is closed, and the app is current again.
    await expect.poll(() => browser.pages.length).toBe(1)
    expect((await call(readPage, {}, ctx())).text).toContain('# Orders')

    expect(site.requests.filter((r) => r.startsWith('site.test '))).toEqual([])
  })

  it('answers at once when a goto is redirected to a site that is not allowed', async () => {
    browser = testBrowser()
    await call(grantSite, { site: 'site.test' }, ctx())
    const started = Date.now()
    const { text } = await act({ do: 'goto', url: site.other('site.test', '/away') })
    expect(text).toContain('blocked http://other.test')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('answers at once when a new tab is redirected to a site that is not allowed', async () => {
    browser = testBrowser()
    await call(grantSite, { site: 'site.test' }, ctx())
    const page = (await act({ do: 'goto', url: site.local('/app') })).text
    const started = Date.now()
    await act({ do: 'click', ref: refOf(page, 'button "Popup redirect"') })
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('follows a redirect to a site once it is granted', async () => {
    browser = testBrowser()
    await call(grantSite, { site: 'site.test' }, ctx())
    await act({ do: 'goto', url: site.local('/app') })
    const page = (await call(readPage, {}, ctx())).text
    expect((await act({ do: 'click', ref: refOf(page, 'link "Redirect away"') })).text).toContain('# External page on site.test')
  })

  it('allows sites from PROWL_ALLOW without a grant', async () => {
    browser = testBrowser({ allow: ['site.test'] })
    expect((await act({ do: 'goto', url: site.other('site.test', '/page') })).text).toContain('# External page on site.test')
  })

  it('opens a new tab on an allowed site, holding its first load until the tab is guarded', async () => {
    browser = testBrowser()
    const page = (await act({ do: 'goto', url: site.local('/app') })).text
    const { text } = await act({ do: 'click', ref: refOf(page, 'button "Open tab"') })
    expect(text).toContain('new tab 1 opened')
    expect(text).toMatch(/\[e\d+ button "Old"\]/)
    expect(browser.pages).toHaveLength(2)
    const started = Date.now()
    const closed = (await act({ do: 'close_tab' })).text
    expect(Date.now() - started).toBeLessThan(3000)
    expect(closed).toContain('# Orders')
    expect(browser.pages).toHaveLength(1)
  })

  it('stops a new tab on a granted site from redirecting to one that is not', async () => {
    browser = testBrowser()
    site.requests.length = 0
    await call(grantSite, { site: 'site.test' }, ctx())
    const page = (await act({ do: 'goto', url: site.local('/app') })).text
    const { text } = await act({ do: 'click', ref: refOf(page, 'button "Popup redirect"') })
    expect(text).toContain('blocked http://other.test')
    expect(site.requests).toContain('site.test /away')
    expect(site.requests.filter((r) => r.startsWith('other.test '))).toEqual([])
  })

  it('blocks an iframe from a site that is not allowed, and loads it once granted', async () => {
    browser = testBrowser()
    site.requests.length = 0
    const blocked = (await act({ do: 'goto', url: site.local('/embed') })).text
    expect(blocked).toContain('blocked iframe http://site.test')
    expect(site.requests.filter((r) => r.startsWith('site.test '))).toEqual([])
    await call(grantSite, { site: 'site.test' }, ctx())
    await act({ do: 'reload' })
    expect(site.requests).toContain('site.test /page')
  })
})

describe('downloads and the window', () => {
  it('saves a download under the downloads folder and says where', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prowl-downloads-'))
    try {
      browser = testBrowser({ downloadsDir: dir })
      const page = (await act({ do: 'goto', url: site.local('/app') })).text
      const first = (await act({ do: 'click', ref: refOf(page, 'link "Download"') })).text
      expect(first).toContain(`downloaded report.txt from ${site.local('/file')} to ${join(dir, 'report.txt')} (5 bytes)`)
      expect(await readFile(join(dir, 'report.txt'), 'utf8')).toBe('hello')
      // A second download of the same name does not overwrite the first.
      const second = (await act({ do: 'click', ref: refOf(page, 'link "Download"') })).text
      expect(second).toContain(join(dir, 'report (1).txt'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('stays hidden with the same page when there is no screen to show the window on', async () => {
    const saved = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY }
    delete process.env.DISPLAY
    delete process.env.WAYLAND_DISPLAY
    try {
      browser = testBrowser()
      await act({ do: 'goto', url: site.local('/app') })
      const { text } = await act({ do: 'show' })
      expect(text).toContain('✗ show: There is no screen to show the browser on')
      expect(browser.headed).toBe(false)
      expect((await call(readPage, {}, ctx())).text).toContain('# Orders')
    } finally {
      Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined)))
    }
  })
})

describe('logs, pictures and scripts', () => {
  it('lists failed requests and shows one with its payload and body', async () => {
    browser = testBrowser()
    const page = (await act({ do: 'goto', url: site.local('/app') })).text
    await act({ do: 'click', ref: refOf(page, 'button "Save"') })
    const problems = (await call(readLogs, {}, ctx())).text
    expect(problems).toContain('console error: boom')
    const id = Number(problems.match(/request #(\d+)/)?.[1])
    const detail = (await call(readLogs, { request: id }, ctx())).text
    expect(detail).toContain('sent: {"qty":3}')
    expect(detail).toContain('body: {"error":"nope"}')
    const network = (await call(readLogs, { network: true, filter: '/api/' }, ctx())).text
    expect(network).toMatch(/#\d+ POST 500 fetch \d+ms \/api\/fail/)
  })

  it('pictures the viewport within maxEdge and states the token cost', async () => {
    browser = testBrowser()
    await act({ do: 'goto', url: site.local('/app') })
    const shot = await call(readScreenshot, { maxEdge: 640 }, ctx())
    expect(shot.text).toContain('640×400 px · about 342 tokens')
    expect(shot.result.content.some((c) => c.type === 'image')).toBe(true)
  })

  it('runs a script in the page and returns its value', async () => {
    browser = testBrowser()
    await act({ do: 'goto', url: site.local('/app') })
    expect((await call(execScript, { code: 'return document.title' }, ctx())).text).toContain('"App"')
  })

  it('uses a fresh profile, and says so, while another running prowl holds the profile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prowl-profile-'))
    try {
      // The test runner's parent process stands in for another prowl session.
      await writeFile(join(dir, 'prowl.lock'), String(process.ppid))
      browser = testBrowser({ profileDir: dir })
      const held = (await act({ do: 'goto', url: site.local('/app') })).text
      expect(held).toContain('Another prowl session is using the browser profile')
      await browser.close()

      // A lock left by a process that is gone is taken over, and released on close.
      await writeFile(join(dir, 'prowl.lock'), '999999999')
      browser = testBrowser({ profileDir: dir })
      const taken = (await act({ do: 'goto', url: site.local('/app') })).text
      expect(taken).not.toContain('Another prowl session')
      expect(await readFile(join(dir, 'prowl.lock'), 'utf8')).toBe(String(process.pid))
      await browser.close()
      await expect(readFile(join(dir, 'prowl.lock'), 'utf8')).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('says how to start when no page is open', async () => {
    browser = testBrowser()
    const { text, isError } = await call(readPage, {}, ctx())
    expect(isError).toBe(true)
    expect(text).toContain('act_page')
  })
})
