# Task Companion

## Start the board

1. Install Node.js 20 or newer if it is not already installed.
2. From Terminal, enter this folder and run `node server.mjs`.
3. Open [http://127.0.0.1:43129](http://127.0.0.1:43129).

**Do not open `dashboard/index.html` directly from Finder or a `file://` URL.** The dashboard needs the local server for its stylesheet, scripts, and data API. A file URL will look unstyled and show no saved tasks. If that happens, use the HTTP address above; the server is already configured to start after login.

Task data stays in this package's `data/state.json` file. Use the download icon in the sidebar to export a backup.

## Keep the local service available after login

Run `node scripts/install-launch-agent.mjs` once. This registers a macOS LaunchAgent that starts the local server after login. To remove it, run `node scripts/uninstall-launch-agent.mjs`. Uninstalling keeps task data.

## Current boundaries

- The independent chat panel is present, but its AI provider is intentionally not configured yet.
- Briefs are pasted manually. When you finish a timed focus session with the focus card’s “完成” button, the task is added to the Mac default calendar from its original start time to the completion time. The first write requires macOS Calendar access permission. “结束陪跑” and the task-list checkmark do not add calendar events.
- Progress check-ins can be entered in the dashboard or the Mac floating companion. The companion stays above other windows and sends a macOS notification at each selected check-in interval. Use the dashboard’s “打开/关闭悬浮窗” button or the menu-bar “伴” icon to control it. Allow notifications when macOS asks. The dashboard service and companion start after login. iPhone notifications are not used.
- Open “外观” in the floating companion to set opacity (40–100%) and choose compact, standard, or roomy size. These preferences are saved for the current Mac account.
- If a focus timer is still active after midnight, the dashboard pauses settlement and asks whether to end it at yesterday’s last progress record, choose an end time yesterday, or confirm that work continued today. The timer never rolls into the new day without confirmation.
- The AI coach now uses a strict accountability tone: it challenges vague progress and avoidance, while criticizing actions rather than the person.
