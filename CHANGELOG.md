# Changelog

## 0.1.0 (unreleased)

- Tools: `read_page`, `read_logs`, `read_screenshot`, `act_page`,
  `grant_site`, `exec_script`.
- Local sites open freely; any other site only after `grant_site`, for the
  session. Every top-level page load is checked in the browser, so links,
  redirects and popups can't get around it; a blocked popup tab is closed.
- Pages as compact text with refs that stay stable while an element lives;
  passwords never shown.
- `act_page` answers with the page's changes, new console errors and failed
  requests; after a navigation, the new page.
- `read_logs` shows one request with its payload and response body.
- Confirm and prompt dialogs are dismissed unless a step accepts them.
- `PROWL_ALLOW`, `PROWL_HEADED`, `PROWL_PROFILE_DIR`; `prowl install`
  downloads Chromium.
