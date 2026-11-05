import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { normalizeSite, Sites } from '../src/browser/sites.js'

describe('Sites', () => {
  it('allows local hosts on any port without a grant', () => {
    const sites = new Sites()
    for (const url of ['http://localhost:4200/', 'http://127.0.0.1:7001/x', 'http://[::1]:3000/', 'http://app.localhost/', 'about:blank']) {
      expect(sites.check(url).ok, url).toBe(true)
    }
  })

  it('blocks other sites until granted, then allows them and their subdomains only', () => {
    const sites = new Sites()
    expect(sites.check('https://github.com/x')).toMatchObject({ ok: false, host: 'github.com' })
    expect(sites.grant('https://GitHub.com/RedFoxxo')).toEqual({ ok: true, site: 'github.com' })
    expect(sites.check('https://github.com/x').ok).toBe(true)
    expect(sites.check('http://gist.github.com/').ok).toBe(true)
    expect(sites.check('https://notgithub.com/').ok).toBe(false)
    expect(sites.check('https://github.com.evil.io/').ok).toBe(false)
  })

  it('never opens non-web pages', () => {
    const sites = new Sites(['example.com'])
    for (const url of ['file:///etc/passwd', 'data:text/html,hi', 'chrome://settings', 'javascript:alert(1)']) {
      expect(sites.check(url).ok, url).toBe(false)
    }
  })

  it('refuses to grant a whole top-level domain or something that is not a site', () => {
    const sites = new Sites()
    expect(sites.grant('com').ok).toBe(false)
    expect(sites.grant('*.com').ok).toBe(false)
    expect(sites.grant('file:///tmp').ok).toBe(false)
    expect(sites.granted).toEqual([])
  })

  it('reads always-allowed sites from PROWL_ALLOW', () => {
    const config = loadConfig({ PROWL_ALLOW: 'staging.example.com, https://dev.example.org:8443;' })
    const sites = new Sites(config.allow)
    expect(sites.check('https://staging.example.com/login').ok).toBe(true)
    expect(sites.check('https://dev.example.org/').ok).toBe(true)
    expect(sites.check('https://example.com/').ok).toBe(false)
    expect(normalizeSite('*.example.com')).toBe('example.com')
  })
})
