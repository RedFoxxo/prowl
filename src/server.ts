import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { errorText } from './browser/session.js'
import { failure } from './tools/respond.js'
import { allTools, type AnyToolDef } from './tools/index.js'
import { tierOf, type ToolContext } from './tools/types.js'
import { VERSION } from './version.js'

export function createServer(ctx: ToolContext, tools: AnyToolDef[] = allTools()): McpServer {
  const server = new McpServer({ name: 'prowl', version: VERSION })
  const seen = new Set<string>()

  for (const tool of tools) {
    const tier = tierOf(tool.name)
    if (!tier) throw new Error(`Tool "${tool.name}" has no tier prefix (read_/act_/grant_/exec_)`)
    if (seen.has(tool.name)) throw new Error(`Tool "${tool.name}" is registered twice`)
    seen.add(tool.name)

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input,
        annotations: { readOnlyHint: tier === 'read', destructiveHint: tier === 'act' || tier === 'exec', openWorldHint: true },
      },
      async (args: Record<string, unknown>) => {
        try {
          return await tool.handler(args, ctx)
        } catch (error) {
          return failure(errorText(error))
        }
      },
    )
  }

  return server
}
