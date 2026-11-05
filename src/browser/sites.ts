/**
 * Which sites the browser may open. Local hosts and the configured ones are
 * always allowed; any other site only after `grant_site`, for this session.
 * A site covers itself and its subdomains: "google.com" covers
 * "accounts.google.com". Ports and schemes do not matter.
 */

export type Verdict = { ok: true } | { ok: false; host?: string; reason: string }

export function isLocalHost(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127(\.\d{1,3}){3}$/.test(host)
}

/** "https://GitHub.com/x", "github.com", "*.github.com" or "github.com:443" → "github.com"; undefined when it is not a site. */
export function normalizeSite(input: string): string | undefined {
  let text = input.trim().toLowerCase().replace(/^\*\./, '')
  if (text === '') return undefined
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text)) text = `http://${text}`
  let host: string
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  } catch {
    return undefined
  }
  if (host === '') return undefined
  return host
}

export class Sites {
  readonly #always: string[]
  readonly #granted = new Set<string>()

  constructor(always: string[] = []) {
    this.#always = always.map((s) => normalizeSite(s)).filter((s): s is string => s !== undefined)
  }

  /** Grants a site for this session; returns it normalized, or an error. */
  grant(input: string): { ok: true; site: string } | { ok: false; reason: string } {
    const site = normalizeSite(input)
    if (!site) return { ok: false, reason: `"${input}" is not a site (use a host such as example.com or a URL)` }
    // A grant names one site, not a whole top-level domain such as "com".
    if (!isLocalHost(site) && !site.includes('.') && !site.includes(':')) {
      return { ok: false, reason: `"${site}" is a whole top-level domain; name one site, such as example.${site}` }
    }
    this.#granted.add(site)
    return { ok: true, site }
  }

  get granted(): string[] {
    return [...this.#granted]
  }

  get always(): string[] {
    return this.#always
  }

  /** May a page be loaded from this URL? */
  check(url: string): Verdict {
    // Pages a browser shows without loading anything from a site.
    if (url === 'about:blank' || url === 'about:srcdoc') return { ok: true }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { ok: false, reason: `not a URL: ${url}` }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: `${parsed.protocol} pages are not opened` }
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
    if (isLocalHost(host)) return { ok: true }
    const covers = (site: string) => host === site || host.endsWith(`.${site}`)
    if (this.#always.some(covers) || [...this.#granted].some(covers)) return { ok: true }
    return { ok: false, host, reason: `${host} is not allowed yet` }
  }
}
