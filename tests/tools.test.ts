import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { allTools } from '../src/tools/index.js'
import { tierOf } from '../src/tools/types.js'

describe('tool list', () => {
  it('names every tool with its permission tier, and only grant_site needs consent', () => {
    const tools = allTools()
    expect(tools.every((t) => tierOf(t.name) !== undefined)).toBe(true)
    expect(tools.filter((t) => tierOf(t.name) === 'grant').map((t) => t.name)).toEqual(['grant_site'])
    expect(tools.filter((t) => tierOf(t.name) === 'exec').map((t) => t.name)).toEqual(['exec_script'])
  })

  it('stays small: names, descriptions and schemas under 8,000 characters', () => {
    const size = allTools().reduce((n, t) => n + t.name.length + t.description.length + JSON.stringify(z.toJSONSchema(z.object(t.input))).length, 0)
    expect(size).toBeLessThan(8000)
  })
})
