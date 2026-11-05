import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import { Browser } from '../src/browser/session.js'
import { Sites } from '../src/browser/sites.js'
import type { AnyToolDef } from '../src/tools/index.js'
import type { ToolContext } from '../src/tools/types.js'

/**
 * A small site on 127.0.0.1. Chromium resolves every host to it, so
 * `http://site.test:PORT` is "another site" for the consent rules while no
 * request leaves the machine.
 */
export interface TestSite {
  port: number
  /** Every request the server got, as "host path". */
  requests: string[]
  local: (path: string) => string
  other: (host: string, path: string) => string
  close: () => Promise<void>
}

function pages(port: number): Record<string, string> {
  const external = `http://site.test:${port}/page`
  return {
    '/app': `<!doctype html><title>App</title>
<h1>Orders</h1>
<p hidden>Secret hidden text</p>
<div style="display:none">Also hidden</div>
<label>Email <input id="email"></label>
<label for="pw">Password</label><input id="pw" type="password">
<label><input type="checkbox" id="agree"> I agree</label>
<select id="size"><option>Small</option><option>Large</option></select>
<button id="save">Save</button>
<button id="del">Delete</button>
<button disabled>Send</button>
<ul><li>First item</li><li>Second item</li></ul>
<table><tr><th>Name</th><th>Qty</th></tr><tr><td>Apple</td><td>3</td></tr></table>
<a href="${external}">External</a>
<a href="/redir">Redirect away</a>
<button id="pop">Popup</button>
<button id="tab">Open tab</button>
<button id="popaway">Popup redirect</button>
<a href="/file">Download</a>
<div id="out"></div>
<script>
save.onclick = async () => { out.textContent = 'Saved!'; console.error('boom'); await fetch('/api/fail', { method: 'POST', body: '{"qty":3}' }) }
del.onclick = () => { out.textContent = confirm('Delete everything?') ? 'Deleted' : 'Kept' }
pop.onclick = () => window.open('${external}')
tab.onclick = () => window.open('/rerender')
popaway.onclick = () => window.open('http://site.test:${port}/away')
</script>`,
    '/embed': `<!doctype html><title>Embed</title><h1>Embed</h1><iframe title="Other" src="${external}"></iframe>`,
    '/rerender': `<!doctype html><title>Rerender</title><div id="box"><button id="b">Old</button></div>
<script>b.onclick = () => { box.innerHTML = '<button>New</button>' }</script>`,
  }
}

export async function startSite(): Promise<TestSite> {
  let port = 0
  const requests: string[] = []
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!
    requests.push(`${req.headers.host?.split(':')[0]} ${path}`)
    if (path === '/api/fail') {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":"nope"}')
      return
    }
    if (path === '/redir' || path === '/away') {
      // /redir goes to site.test, /away (on site.test) goes on to other.test.
      res.writeHead(302, { location: `http://${path === '/redir' ? 'site' : 'other'}.test:${port}/page` })
      res.end()
      return
    }
    if (path === '/file') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="report.txt"' })
      res.end('hello')
      return
    }
    if (path === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<!doctype html><title>External</title><h1>External page on ${req.headers.host?.split(':')[0]}</h1>`)
      return
    }
    const page = pages(port)[path]
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html' })
    res.end(page ?? 'not found')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  port = (server.address() as AddressInfo).port
  return {
    port,
    requests,
    local: (path) => `http://127.0.0.1:${port}${path}`,
    other: (host, path) => `http://${host}:${port}${path}`,
    close: async () => {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    },
  }
}

/** A headless browser, in memory unless given a profile folder, every host mapped to 127.0.0.1. */
export function testBrowser(options: { allow?: string[]; profileDir?: string; downloadsDir?: string } = {}): Browser {
  return new Browser(new Sites(options.allow ?? []), {
    profileDir: options.profileDir,
    downloadsDir: options.downloadsDir,
    headed: false,
    args: ['--host-resolver-rules=MAP * 127.0.0.1', '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable'],
  })
}

/** Calls a tool the way the server does, with its schema applied. */
export async function call(tool: AnyToolDef, args: Record<string, unknown>, ctx: ToolContext) {
  const result = await tool.handler(z.object(tool.input).parse(args), ctx)
  const text = result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n')
  return { text, isError: result.isError === true, result }
}
