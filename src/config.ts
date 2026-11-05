import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Config {
  /** Browser profile kept between sessions (logins, cookies). */
  profileDir: string
  /** Show the browser window instead of running headless. */
  headed: boolean
  /** Sites always allowed besides local hosts, e.g. a dev or staging server. */
  allow: string[]
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    profileDir: env.PROWL_PROFILE_DIR?.trim() || join(homedir(), '.prowl', 'profile'),
    headed: /^(1|true|yes|on)$/i.test(env.PROWL_HEADED?.trim() ?? ''),
    allow: (env.PROWL_ALLOW ?? '').split(/[\s,;]+/).filter((s) => s !== ''),
  }
}
