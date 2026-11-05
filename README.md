# prowl

A token-lean browser [MCP](https://modelcontextprotocol.io) server. An AI
assistant tests your local apps freely, and opens any other site only after
you allow it. Pages are read as compact text; pictures are available, but only
on demand and size-capped.

## What it does

- **Local apps open freely**: `localhost`, `127.0.0.1`, `*.localhost` and
  `::1`, on any port.
- **Every other site needs your yes**: the assistant must call `grant_site`,
  which your client asks you to approve. The site and its subdomains then stay
  allowed until the session ends. The check runs inside the browser before
  any request is sent, for pages, iframes, links, redirects, popups and new
  tabs alike.
- **Small answers**: after an action you get what changed on the page (or the
  new page after a navigation), plus new console errors, failed requests and
  downloads, instead of the whole page again. A GitHub repository page is
  about 10K characters, against 25K for Playwright MCP's snapshot.
- **You sign in yourself**: `act_page` `show` opens the browser window so you
  can type your own password; `hide` puts it back in the background.

## Tools

| Tool | What it does |
|---|---|
| `read_page` | The page as text: headings, lists, table rows, controls as `[e12 button "Save" disabled]` with state and value. Hidden elements left out |
| `read_logs` | Console errors, page errors and failed requests since the page loaded; every request; one request with payload and response body |
| `read_screenshot` | A picture of the viewport or one element, longest side 1024px by default, with its token cost |
| `act_page` | Steps in order: goto, click, fill, type, press, select, check, hover, upload, scroll, wait, back, reload, tabs, dialogs, show/hide the window |
| `grant_site` | Allow a site that is not local, for this session |
| `exec_script` | Run JavaScript in the page |

Tool names start with their tier (`read_`, `act_`, `grant_`, `exec_`), so
client approval rules can allow reading and acting, ask before `grant_site`
and block `exec_script`.

## Setup

1. Node.js 22.12 or newer.
2. Add the server to your MCP client:

   ```json
   {
     "mcpServers": {
       "prowl": { "command": "npx", "args": ["-y", "@redfoxxo/prowl@1"] }
     }
   }
   ```

   The first time it opens a page, prowl downloads its Chromium (about
   120 MB, once per machine). To do that ahead of time, run
   `npx -y @redfoxxo/prowl@1 install`.
3. Set the approval rules. **`grant_site` must ask you**, otherwise the
   assistant can allow sites by itself:

   | Client | Allow | Ask | Deny |
   |---|---|---|---|
   | Claude Code (`permissions` in settings) | `mcp__prowl__read_*`, `mcp__prowl__act_*` | `mcp__prowl__grant_*` | `mcp__prowl__exec_*` |
   | omp (`tools.approval`) | `mcp__prowl_read_page`, `mcp__prowl_read_logs`, `mcp__prowl_read_screenshot`, `mcp__prowl_act_page` | `mcp__prowl_grant_site: prompt` | `mcp__prowl_exec_script: deny` |

| Variable | Default | Purpose |
|---|---|---|
| `PROWL_ALLOW` | none | Sites always allowed besides local ones, comma separated, e.g. a staging server |
| `PROWL_HEADED` | off | `1` starts with the browser window shown |
| `PROWL_PROFILE_DIR` | `~/.prowl/profile` | Browser profile kept between sessions (logins, cookies) |
| `PROWL_DOWNLOADS_DIR` | `~/.prowl/downloads` | Where downloads are saved; a name already there gets ` (1)` |

The profile is prowl's own, never your personal browser. If another prowl
session is already using it, the new one runs in a fresh in-memory profile and
says so. Without a screen (for example over SSH), `show` says so and the
browser keeps running hidden.

## Limits

- Content inside iframes isn't read or acted on; the frame is listed. Iframes
  from sites you haven't allowed aren't loaded at all.
- Images, scripts, styles and API calls a page makes to other servers are not
  checked, otherwise most sites break. Only pages and iframes are.
- Some sites (for example npmjs.com behind Cloudflare) show a bot check to a
  hidden browser. Use `show`, pass the check in the window, then go on.
- `exec_script` runs with the page's own network access, so it can reach any
  site. That's why the suggested rules deny it.
- Page text is untrusted: a site can contain text written to steer an
  assistant. prowl marks page content as data, and the consent rule keeps it
  from opening new sites, but it doesn't stop an assistant from acting on an
  allowed site. Keep approval prompts on for anything that matters.

## License

MIT
