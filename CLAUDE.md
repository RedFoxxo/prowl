# CLAUDE.md

Guidance for working in this repository.

## What this is

**prowl** is a browser MCP server (stdio) on Playwright's Chromium. It lets an
assistant test local apps and, only with the user's consent, browse other
sites, while keeping the assistant's context small.

prowl is generic: it must not mention or depend on any other plugin, tool or
company workflow.

## The consent rule

This is the reason prowl exists. Every change must keep it:

- Local hosts (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`)
  and `PROWL_ALLOW` sites open freely. Any other site opens only after
  `grant_site`, for the rest of the session; nothing is remembered on disk.
- The check is in the browser, before any request leaves it:
  `context.route` aborts every top-level navigation to a site that isn't
  allowed (links, popups, `location =` from scripts). `route` never sees
  redirect hops, so `Browser.#guardRedirects` also intercepts each tab's
  document requests through CDP (`Fetch`, request stage) and fails main-frame
  hops to such a site. `framenavigated` sends a page that got there anyway to
  `about:blank`, and `act_page` refuses `goto` before loading. The test
  "blocks links, redirects and popups" checks the fixture server never got a
  request for the blocked host.
- One process per profile: `prowl.lock` in the profile folder holds the pid.
  A second session runs in memory and says so; a lock whose process is gone
  is taken over.
- `grant_site` is the only `grant_` tool. Clients ask the user before it runs;
  its description tells the assistant to call it only after the user agreed.
- Non-web schemes (`file:`, `data:`, `chrome:` …) are never opened.
- Subresources (images, scripts, XHR) and iframes are not gated, otherwise
  sites break; `exec_script` is not gated either, so it is denied by default.

## Token budget rules

- **Few tools.** `tests/tools.test.ts` caps names, descriptions and schemas
  at 8,000 characters.
- **Text first.** Pages are lines (`src/browser/inpage.ts`), at most
  `PAGE_CHARS` (12,000) characters per answer, then a `[more: …]` footer.
- **Changes, not pages.** `act_page` answers with a line diff; the page is
  printed (6,000 characters) only after a navigation.
- **Pictures last.** `read_screenshot` is the only tool returning an image,
  size-capped, with its token cost.

## Stack

- TypeScript (strict), ESM, Node `>=22.12`
- `@modelcontextprotocol/sdk` (stdio), `zod`, `playwright-core`, `vitest`
- No other runtime dependencies; ask before adding one. Versions are pinned
  exactly. Bumping `playwright-core` changes the Chromium build: users run
  `prowl install` again.

Before every commit run `npm run typecheck`, `npm test` and `npm run build`.

## Architecture

```
src/
  index.ts          `prowl` (stdio server) and `prowl install` (Playwright's Chromium download)
  server.ts         tool registration; tier prefix check and MCP annotations
  config.ts         PROWL_ALLOW, PROWL_HEADED, PROWL_PROFILE_DIR
  browser/
    sites.ts        which sites may open: local, always allowed, granted
    session.ts      Browser: lazy launch, the route guard, tabs, console and network log, dialogs, settle
    inpage.ts       functions run inside the page: the snapshot walker and the mutation watch
  format/page.ts    paging and the line diff
  tools/            read.ts, act.ts, grant.ts (grant_site, exec_script), respond.ts, types.ts, index.ts
```

- `inpage.ts` functions are sent to the page as source text: each must be
  self-contained (no imports, no outer variables).
- Refs are a `data-prowl-ref` attribute, so an element keeps its ref while it
  lives; a re-rendered element gets a new one and old refs fail with a hint.
- JavaScript dialogs are dismissed unless an `act_page` `dialog` step said to
  accept the next one. Alerts are accepted.

## Tests

`tests/fixture.ts` serves a small site on 127.0.0.1 and starts headless
Chromium with every host mapped to it, so `site.test` is "another site"
without network access. Tests check what a user would notice: what an answer
contains and leaves out, which pages load or are blocked, and what the page
ends up showing.
