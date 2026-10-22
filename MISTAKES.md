# Mistakes to avoid

- **Browser checks in this project:** don't send an action and the screenshot in the same parallel batch. The screenshot can run before the UI updates and show the old state (happened repeatedly). Do the action, wait for a specific text or selector, then screenshot.
- **iOS simulator, scrolling up:** don't swipe down from the top of the page to get back up. Safari's own pull-to-refresh reloads the page and wipes in-memory state (location, open cards), which looked like an app bug. Tap the Pinned tab instead (it scrolls to the top).
- **iOS simulator, first tap:** when Safari's toolbar is collapsed, the first tap on the page is often swallowed (it just shows the toolbar). If nothing happened, screenshot and tap again before assuming the app is broken.
- **iOS simulator, first page load after boot:** `simctl openurl` right after booting leaves Safari stuck loading a blank page (happened every boot). Tap the stop button, then reload, before judging the page. After a reboot the Home Screen opens on page 1; the added web apps are on page 2.
- **Node tests:** a `setInterval` in a module keeps the test process alive forever. Call `.unref()` on timers created at import/construct time (fixed in `push.js`).
- **Stopping test processes:** don't `pkill -f`/`pgrep -f` with a pattern inside the same shell command that contains that pattern. It matches (and kills) the shell running the command itself (exit 144, happened twice). Start background processes with `& echo $! > /tmp/x.pid` and `kill $(cat /tmp/x.pid)`.
