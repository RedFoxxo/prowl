#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { installChromium } from './browser/install.js'
import { Browser } from './browser/session.js'
import { Sites } from './browser/sites.js'
import { loadConfig } from './config.js'
import { createServer } from './server.js'

async function serve(): Promise<void> {
  const config = loadConfig()
  const browser = new Browser(new Sites(config.allow), {
    profileDir: config.profileDir,
    downloadsDir: config.downloadsDir,
    headed: config.headed,
    install: () => installChromium('stderr'),
  })
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
  if (command === 'install') return installChromium('inherit')
  if (command === undefined) return serve()
  process.stderr.write(`prowl: unknown command "${command}". Usage: prowl (MCP server on stdio) | prowl install\n`)
  process.exit(1)
}

main().catch((error: unknown) => {
  process.stderr.write(`prowl: fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
