#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Browser } from './browser/session.js'
import { Sites } from './browser/sites.js'
import { loadConfig } from './config.js'
import { createServer } from './server.js'

/** `prowl install`: downloads the Chromium build this Playwright version drives. */
async function install(): Promise<void> {
  const cli = join(dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')), 'cli.js')
  const child = spawn(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' })
  const [code] = (await once(child, 'exit')) as [number | null]
  process.exit(code ?? 1)
}

async function serve(): Promise<void> {
  const config = loadConfig()
  const browser = new Browser(new Sites(config.allow), { profileDir: config.profileDir, headed: config.headed })
  const server = createServer({ browser })
  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    // Closing the browser flushes the profile, so logins survive to the next session.
    await browser.close()
    process.exit(0)
  }
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  await server.connect(new StdioServerTransport())
  process.stderr.write(`prowl: ready on stdio${config.allow.length > 0 ? `; always allowed: ${config.allow.join(', ')}` : ''}\n`)
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2)
  if (command === 'install') return install()
  if (command === undefined) return serve()
  process.stderr.write(`prowl: unknown command "${command}". Usage: prowl (MCP server on stdio) | prowl install\n`)
  process.exit(1)
}

main().catch((error: unknown) => {
  process.stderr.write(`prowl: fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
