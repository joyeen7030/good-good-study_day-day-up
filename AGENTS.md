# Dashboard launch and browser handling

- This dashboard must be opened through the local server at `http://127.0.0.1:43129/`.
- Never open `dashboard/index.html` directly as a `file://` URL. That bypasses the CSS/JavaScript routes and the `/api/*` endpoints, so the page appears unstyled and cannot load or save task data.
- Before telling the user the board is ready, verify that the local service responds over HTTP and that the active browser page uses the `http://127.0.0.1:43129/` origin.
- If a browser has both a `file://` tab and the HTTP dashboard tab, identify the HTTP tab as the working board. Do not modify or troubleshoot the raw file tab as though it were the running app.
- If browser policy or controls prevent switching tabs, explain that the user should open `http://127.0.0.1:43129/` in the address bar; do not claim the raw file tab is fixed.
