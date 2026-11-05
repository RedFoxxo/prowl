import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * Downloads the Chromium build this playwright-core version drives (about
 * 120 MB, once per machine). `output: 'stderr'` keeps stdout clean while the
 * MCP server is talking on it.
 */
export async function installChromium(output: 'inherit' | 'stderr'): Promise<void> {
  const cli = join(dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')), 'cli.js')
  const child = spawn(process.execPath, [cli, 'install', 'chromium'], { stdio: output === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'inherit'] })
  child.stdout?.pipe(process.stderr)
  const [code] = (await once(child, 'exit')) as [number | null]
  if (code !== 0) throw new Error(`Downloading Chromium failed (exit code ${code}). Run \`npx -y @redfoxxo/prowl@latest install\` to see why.`)
}
