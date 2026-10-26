# Browser plugin template

Copy this directory to a sibling `~/development/pi-browser-myapp`. Rename the package, descriptor ID/title/description, and command. Adjust `file:../pi-browser` if the host checkout is elsewhere.

```sh
npm install --ignore-scripts
npm run check
pi install ~/development/pi-browser
pi install .
```

Finish active inspection/Dream, then `/reload`. Use `/browser-plugins`, `/browser-plugin example`, or `/example-browser`. The example expects an already-running app on `http://localhost:3000`; it starts no server and defaults Private ON.

See the host's `docs/plugins.md` for API, privacy, cancellation, process ownership, and trust contracts. Plugins are trusted Pi extensions, not sandboxed code. Keep resources in the factory closure, register during `session_start`, confirm before consequential setup, pass abort signals through, and stop only resources you own. Never put credentials in metadata, arguments, UI notifications, raw error output, or fixtures.
