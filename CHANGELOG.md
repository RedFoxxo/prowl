# Changelog

## 1.0.0 (2026-11-05)

- Tools: `read_page`, `read_logs`, `read_screenshot`, `act_page`,
  `grant_site`, `exec_script`.
- Local sites open freely; any other site only after `grant_site`, for the
  session. Pages and iframes are checked in the browser before any request is
  sent: links, redirects, popups and new tabs can't get around it. A new
  tab's first load is held until its redirect check is on. A tab that only
  shows a blocked page is closed.
- Pages as compact text with refs that stay stable while an element lives;
  passwords never shown.
- `act_page` answers with the page's changes, new console errors, failed
  requests and downloads; after a navigation, the new page. A disabled
  control fails at once instead of after a timeout.
- `act_page` `show` and `hide` open and close the browser window, keeping
  tabs and logins, so the user can sign in themselves.
- Downloads are saved to `PROWL_DOWNLOADS_DIR` and reported.
- `read_logs` shows one request with its payload and response body.
- Confirm and prompt dialogs are dismissed unless a step accepts them.
- One prowl process per profile; a second runs in a fresh in-memory profile.
- Chromium is downloaded on first use; `prowl install` does it ahead of time.
- `PROWL_ALLOW`, `PROWL_HEADED`, `PROWL_PROFILE_DIR`, `PROWL_DOWNLOADS_DIR`.
