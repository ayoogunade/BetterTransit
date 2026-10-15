# Mistakes to avoid

- **Browser checks in this project:** don't send an action and the screenshot in the same parallel batch. The screenshot can run before the UI updates and show the old state (happened repeatedly). Do the action, wait for a specific text or selector, then screenshot.
- **Node tests:** a `setInterval` in a module keeps the test process alive forever. Call `.unref()` on timers created at import/construct time (fixed in `push.js`).
