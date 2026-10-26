# pi-browser

A screenshot-driven Chromium browser inside Pi. The agent can browse local apps or
internet websites, manipulate them, and inspect the same screenshots shown to the
user. **Inspection** lets the user click, scroll, and type in the website inside Pi; the agent's `browser`
tool remains available for automated browsing. **Dream** adds a separate visual mockup
editor: select real DOM elements, reposition them, duplicate them, and rewrite text
before saving a goal screenshot.

## Setup and try it

Requires Pi and Node.js 22.19+. From this directory:

```sh
npm install --ignore-scripts
npm run browser:install
npm run dev
```

Chromium is installed in Playwright's OS cache, not bundled in this package.
On Linux you may also need Playwright's system libraries (`npx playwright install --with-deps chromium`, which may require elevated privileges).
Pi loads TypeScript directly; no build step is necessary.

Ask Pi something like:

> Open http://localhost:3000 in the browser, inspect the layout, click through the
> main flow, and show me a screenshot of the finished result.

The `browser` tool returns an image after every successful action except `close`.
Pi receives a PNG image block, not just a filename. Pi's native terminal image
renderer displays the same screenshot inline in the tool result. Use a terminal
supporting Kitty or iTerm2 image protocols and enable Pi's `terminal.showImages`
setting (default: true). On text-only terminals the tool still returns images to
image-capable models, and provides a saved PNG path for viewing elsewhere.
**This is discrete screenshot feedback after actions, not live video.**

Optional user preview commands:

```text
/browser http://localhost:3000
/browser
/browser close
```

`/browser URL` navigates and opens a read-only preview; `/browser` captures the
current page (or a blank new page). Escape, Enter, or Ctrl+C dismisses the preview.
It is a temporary screen; the agent's tool screenshots appear in the transcript
without blocking on a user dialog. Custom previews require interactive Pi, but
the agent tool also works in RPC/JSON/print modes.

One-off load from anywhere:

```sh
pi --extension ~/development/pi-browser/src/index.ts
```

Optional persistent installation (not performed automatically):

```sh
pi install ~/development/pi-browser
```

After editing an already-loaded extension, use `/reload`.

## Optional browser plugins

Install companion integrations as ordinary Pi packages, separately from pi-browser.
Use `/browser-plugins` to list them, `/browser-plugin ID [options]` to open one,
or the agent's `browser_plugin` tool (`list`, `open`, `stop`). Integrations default
to Private ON before target navigation and return no page output through the
plugin tool. Consequential setup must be confirmed by the companion.

The versioned SDK is exported at `pi-browser/plugins`. See
[Plugin API and authoring guide](docs/plugins.md) and
[`examples/plugin-template`](examples/plugin-template) for a reusable package.

## Clickable inspection

```text
/inspect https://developers.cloudflare.com/agents/examples/voice-agent/
/inspect http://localhost:3000
/inspect
```

`/inspect URL` opens an inspection overlay. Without a URL it uses the browser's
current page. Click buttons or links, click a field and type, or scroll over the
page. Input is forwarded to Chromium, then the screenshot and URL refresh. It uses the same
browser context as the agent's `browser` tool.

The agent can also open inspection using `browser_inspect` with an optional `url`.
Ask: **“Open an inspection of http://localhost:3000 so I can click around.”**
The agent waits while you inspect. **Esc**, **Ctrl+Q**, or the **Done** button
returns control; the tool then returns the last captured screenshot and successful
click count. Finishing inspection **does not constitute approval** of the work.

Requirements and behavior:

- **Fullscreen Pi + Kitty graphics** (for example Ghostty, Kitty, or WezTerm).
  This Pi version disables iTerm2-only images in fullscreen mode. Regular-mode,
  RPC, and text-only clients cannot use clickable inspection. Use `/settings`
  to select fullscreen, or launch `pi --tui-mode fullscreen`.
- The image fits the overlay's available terminal width and height, independently
  of `terminal.imageWidthCells` (which controls static transcript screenshots).
- Clicks map from the centre of a terminal cell to the displayed image's viewport
  pixels. Terminal mouse protocols don't report exact sub-cell positions, so very
  small targets may be difficult to click. Make the terminal larger for precision.
- **Refresh** or **Ctrl+R** captures delayed changes; plain **r** now types text.
  **Enter**, **Tab/Shift+Tab**, arrows, Home/End, PageUp/PageDown, Backspace/Delete,
  and modifier shortcuts go to the webpage. **Esc** is reserved for closing
  inspection (not forwarded to browser menus). Ctrl+C is now a browser key, not an
  inspection exit shortcut. Host clipboard copy/synchronization is not implemented;
  use your terminal's paste action to deliver clipboard text as bracketed paste.
- Click a field to focus it, then type. Unicode and committed IME text are supported;
  native IME composition/candidate positioning is not integrated. Bracketed paste
  supports multiline text in textareas; terminal key press/repeat events are
  forwarded, while key releases and unsupported terminal sequences are ignored.
- Wheel scrolling targets the screenshot point under the pointer, including nested
  scroll containers. **Shift+wheel** scrolls horizontally; PageUp/PageDown and
  arrows provide keyboard scrolling where the webpage allows it. This Pi mouse
  API reports logical wheel lines rather than exact trackpad pixels.
- Typing and wheel events are buffered while screenshots update. Adjacent text
  and compatible wheel events are coalesced, preserving order across editing keys.
  Chromium applies each queued burst and captures once at its end; feedback is
  screenshot-based rather than live video. The queue is bounded (1024 actions,
  100,000 queued text characters); overflow is reported, not silently truncated.
- Hover, dragging, right-click, modifier-click, and double-click semantics are not
  implemented. Background transcript selection/scrolling is suppressed.
- Extra coordinate clicks are ignored while an action is running to avoid stale
  targets, but typing and scrolling are queued instead of dropped. If an action
  fails, pending input is cleared; refresh before retrying. Closing during
  an in-flight action cancels it and closes Chromium; otherwise the browser stays
  open at the page you inspected for subsequent agent calls.
- User clicks and Enter keypresses are real website actions and can submit forms
  or cause other side effects. Inspect only sites you intend to interact with. Agent permission gates
  apply to opening the tool, not each human click. The final screenshot and page
  data are recorded when using the tool; individual human input events are not
  separate agent tool calls. Entered text can appear in saved PNGs/page data and
  in the final result sent to the model provider. Enable Private before entering
  sensitive information; password filtering alone does not cover other form values.

### Password filtering and explicit Private mode

No login-page detection is used. Password filtering is **always on**, and **Private
mode defaults to OFF**. Click **[Private: OFF/ON]** in either inspection or Dream's
top bar, or press **Ctrl+Shift+P** (also useful when the toolbar is clipped).
Wait for the privacy transition to finish before typing. Private ON is shown with
a warning-colored toolbar and a local-only status banner.

**Always-on password protection:**
- Recognized password inputs are masked in screenshots and omitted from accessibility
  snapshots, including open shadow roots and frames. Previously observed fields stay
  protected after a site's Show password switch. Password autocomplete hints are also
  recognized. Real field values are not changed.
- Known password literals (including common JSON/URL encodings) are redacted from
  output text and metadata; matching ordinary DOM text/control values are masked too.
  This can conservatively mask unrelated text that matches a short password/prefix.
- Dream cannot edit/copy a protected password field. Copying a container clears its
  cloned password values instead of copying them into the internal clipboard.

**While Private is ON:**
- Human inspection/Dream still works locally. Ordinary agent browser actions are
  blocked, and tool results withhold page pixels, accessibility text, URLs, titles,
  and file paths. Old private frames remain private even after switching OFF.
- Screenshots stay in memory, with no temporary PNG writes. Dream activity logging
  is paused; `/dream-log` withholds diagnostics. No goal PNG/manifest is saved or
  published when you finish while private. Use `/dream` to resume the mockup.
- Private state follows the inspection-to-Dream handoff and stays enabled across
  navigation. Private edit history is exported only as omitted markers; undo/redo
  stays local, including after privacy is turned OFF.
- Turning OFF waits for queued input, then makes a fresh protected capture. **It
  allows the current page to be shared again**, including non-password form values
  visible on that page. Turn it OFF deliberately, not merely to save a secret form.

**Boundary:** this is a plugin output/artifact policy, not an OS sandbox or a formal
secret-detection guarantee. It cannot retract prior output, recognize every custom
password widget/closed shadow root, or reliably detect transformed secrets in
canvas/images/CSS or unknown plain-text copies. Use Private mode for usernames,
OTPs, tokens, sensitive page data, and uncertain password controls. It does not stop
normal website requests or protect against other extensions, unrestricted local
shell access, terminal recording, or explicit debug tracing. Private mode refuses
opt-in browser video recording; demo recorders are not private authentication tools.
Never put secrets into chat or agent tool arguments: they reach the model before
this plugin can filter a result. No authentication cookies/storage are exported.

### Authenticate in inspection, then enter Dream

```text
/inspect https://your-app.example.com
```

Log in manually, wait for the intended application page, then press **Shift+D**
(outside a text field, while the browser is idle) or click **[Dream]** in the inspection toolbar. A loading
screen appears while queued inspection input finishes and the editor starts.
Inside text fields or during pending browser updates, Shift+D still types `D` to
avoid mistaking stale focus for a shortcut; pasted `D` is always literal text.
The explicit **[Dream]** button can queue a handoff even while input is pending.

The handoff **moves the live Chromium browser context and active page into Dream**.
Cookies (including HttpOnly and binding cookies), sessionStorage, localStorage,
IndexedDB, tabs, and browser authentication stay in the same context; credentials
are not exported to an auth file, tool arguments, or the saved goal. The page reloads
so Dream can install its input guards before application scripts. Browser storage
survives, but unsaved form contents and JavaScript-only state may not. Finish any
login redirects before switching. This does not change Access policies or guarantee
that an identity provider's passkey/security-key flow works in headless Chromium.

Dream now owns that authenticated session. Ordinary browser tools and subsequent
inspections start with a fresh profile, so they cannot operate on the live mockup.
`/dream` without a URL resumes the transferred session. Switching replaces any prior
Dream profile/mockup; save an earlier goal first. Pi `/reload`, session changes, and
shutdown discard both profiles; browser page reloads alone do not erase auth storage.

Edit the page, then **Esc** (when not editing text or dismissing a menu/log) or
**[Done]** saves the clean PNG, change manifest, and activity log under `.pi/dreams/`,
and publishes a visual reference without starting an agent turn. Ctrl+Q while an
error is displayed cancels without publishing. This works from both `/inspect` and
`browser_inspect`; a tool-opened inspection keeps the agent paused through Dream.
All normal inspection privacy cautions still apply: visible page content and entered
text may appear in screenshots/page data. Authenticated app data in goals is sensitive.

### Local click playground

In another terminal:

```sh
cd ~/development/pi-browser
npm run demo
```

Then in Pi:

```text
/inspect http://127.0.0.1:4173
```

Try **Increase +**, **Reset**, **Change theme**, and **Open details page**.
Click **Name** and type, then press Enter to submit the local greeting form. Scroll
further down to try **Notes** (including multiline paste) and the nested scroll panel.
The demo binds only to loopback; stop it with Ctrl+C in the serving terminal.
Use `PORT=4180 npm run demo` if 4173 is already occupied.

### Record a controls demo

With the playground server running:

```sh
npm run demo:record -- http://127.0.0.1:4173
open artifacts/inspection-demo/index.html  # macOS: play in your default browser
```

The recorder writes a WebM, an HTML player, a final PNG, and a steps report under
`artifacts/inspection-demo/` (git-ignored). Video recording is opt-in and disabled
in normal Pi sessions. If Playwright asks for its video encoder, install it with
`npx playwright install ffmpeg`.

This records **browser footage**, not a human's terminal session. A virtual terminal
feeds mouse/key events through Pi's real fullscreen renderer into `InspectionView`
and Chromium. It demonstrates typing, Enter submission, page scrolling, Unicode
multiline paste, and nested vertical/horizontal scrolling using the same input path
as inspection. The script is calibrated to this playground at 1280×800; the URL
argument selects its server address, not an arbitrary recording target.

If you can't interact, first close any old inspection, run `/reload`, then open
`/inspect URL` again. Static screenshots and `/browser` previews are not interactive.
Mouse input requires fullscreen mode and supported terminal graphics. If the new
inspection footer still says `r: refresh` or `arrows: move pointer`, old code is loaded;
the current footer includes `Shift+D: Dream` and `Ctrl+R: snapshot`.

## Dream: an editable visual goal

```text
/reload
/dream http://localhost:3000
/dream https://example.com
/dream
```

Direct `/dream URL` opens the rendered page in a **separate ephemeral Chromium profile**.
An explicit inspection-to-Dream handoff instead transfers the inspected profile.
The agent waits while you shape a visual goal. Without a URL, `/dream` resumes the
current mockup; passing a URL navigates afresh and discards that page's unsaved DOM
edits. Reload/session changes/shutdown discard the profile, but saved goals remain.
Dream requires **fullscreen Pi + Kitty graphics**, just like inspection.

### Controls

- **Click** selects the most specific HTML element under the pointer. A purple
  rectangle uses its real `getBoundingClientRect()` bounds, not image segmentation.
  The footer identifies the DOM element and its dimensions. After moving content,
  empty transparent wrapper slots are ignored: clicks reach the visible element
  underneath (or clear selection), without removing the reserved layout space.
- **Right-click** opens Dream's element context menu inside the screenshot. Actions:
  **Copy**, **Paste here**, **Duplicate**, **Edit text**, **Select parent**,
  **Delete element**, **Undo**, and **Redo**. Unavailable actions are disabled. Paste here puts the copy's top-left
  corner at the clicked location; Duplicate makes an offset copy of the selection.
  Opening the menu commits any in-progress text edit and switches to element actions.
- **Actions** in the toolbar or **Shift+F10** opens the same menu for the selection.
  **Up/Down**, **Tab/Shift+Tab**, and **Home/End** navigate enabled items; **Enter**
  chooses one. **Esc** or clicking outside dismisses it without activating the page
  underneath. Scrolling dismisses the menu; Done removes it from the goal screenshot.
- **Parent** selects the containing element, useful for moving/copying whole cards.
- **Drag and release** visually repositions the element. A selected group moves as
  a group when the drag starts over one of its children inside the selected bounds.
  A displaced child outside those bounds is targeted independently. Feedback arrives
  after the drop; this first version does not animate a live drag preview.
- **Resize the current selection** using the eight purple-and-white corner/edge
  handles. Corners change both dimensions; edges change just one. Dragging a handle
  never selects or resizes another element. **Alt+arrow keys**, when forwarded by
  the terminal, adjust the selected width/height by 10 CSS pixels. Handles disappear
  during text editing and while the Actions menu is open. Resize feedback arrives
  on release, not as a live preview. **Esc** cancels an in-progress drag/resize.
  Resizing changes the element's mockup dimensions and may reflow nearby content;
  it does not resize the browser viewport. Sizes are bounded to 16–10,000 CSS pixels
  (padding/borders may impose a larger minimum). Rotated/scaled/zoomed layouts and
  unsupported elements do not get resize handles.
- **Cmd+C / Cmd+V** (when forwarded by the terminal), **Ctrl+C / Ctrl+V**, or the
  **Copy / Paste** buttons duplicate an element. Paste places each copy slightly
  offset and selects it so you can drag it into place. Duplicates are independent
  visual copies, with computed styles captured to retain their appearance.
- **Double-click** a plain-text heading, paragraph, label, or button to select all
  its text and type a replacement. Existing text inputs/textareas are supported
  too. **Edit** or **Enter** on a selection provides a keyboard alternative.
  Double-clicking a container/non-text element keeps it selected and shows a
  non-blocking notice; it does not lock Dream or require Refresh.
  **Enter/Esc** commits; **Shift+Enter** adds a line. Text editing uses the browser's
  selection and cursor, supports Unicode/IME commits and literal bracketed paste.
- **Delete element** in the context/Actions menu removes the selected element and
  its children from the mockup. **Delete / Backspace** does the same when an element
  is selected, but continues to erase text normally during text editing. Removal
  lets the surrounding layout reflow; choose Parent first to remove a whole group.
  Undo restores the same element/subtree in its original position. The document
  root cannot be deleted, and the clipboard remains available after deletion.
- **Undo / Cmd+Z / Ctrl+Z** reverses a complete move, resize, duplicate, deletion, or committed text
  edit. **Cmd/Ctrl+Shift+Z** redoes. The history/edit manifest holds the latest
  **100 undoable edits**, not a source-code patch or exhaustive session recording.
- **Wheel** scrolls the page or nested container under the pointer; **Shift+wheel**
  scrolls horizontally. **Refresh / Ctrl+R** captures delayed page updates.
- **Done**, **Ctrl+Q**, or **Esc** outside text editing waits for queued edits,
  removes selection graphics, and returns a clean goal screenshot. Closing is
  **not approval** and does not ask the agent to implement source changes.

**Terminal shortcut caveat:** many macOS terminals reserve Cmd+C/V for their own
clipboard. Pi cannot receive a shortcut the terminal consumes. Configure your
terminal to forward Super+C/V using the Kitty keyboard protocol, or use the right-click
menu, Ctrl+C/V, and the toolbar. Copy/paste is an **internal Dream clipboard**, not OS clipboard
synchronization. While editing text, these shortcuts copy/paste text rather than
DOM objects. Your terminal's ordinary paste action inserts external clipboard
text into the currently edited text element.

**Ghostty right-click:** with mouse reporting enabled (as in fullscreen Pi), Ghostty
1.3.1 forwards plain right-click to the app before considering its own context menu.
No terminal settings need to change. **Shift+right-click** bypasses mouse reporting
with Ghostty's defaults and can open its native terminal menu instead. Use plain
right-click/two-finger secondary click for Dream; Actions/Shift+F10 is the fallback.

### Recent activity and troubleshooting

- **Log** in the toolbar opens a read-only recent-activity view without leaving
  Dream. **Wheel**, **Up/Down**, **PageUp/Down**, **Home/End** browse it; **Esc** or
  **Log** returns to editing. Typing in the log does not change the page.
- After closing Dream, **`/dream-log`** posts the latest 20 diagnostic events and
  the complete log's file path to the transcript without starting an agent turn.
  You can ask the agent to read the file and troubleshoot a problem.
- The latest **100 diagnostic events** are retained at
  **`<cwd>/.pi/dreams/activity.json`**. This is a rolling ring, not 100 edits or a
  complete session recording: one input may produce multiple events. Events carry
  timestamps and session IDs, so reopened sessions can be distinguished. The ring
  survives `/reload` and cancellation; it is updated during Dream, not just on Done.
- It records input/action requests that reach Chromium, pointer coordinates, selected DOM tag/selector and
  bounds, menu state, edit counts, notices, errors, recovery, and session completion.
  It does **not** record typed text, clipboard contents, before/after text edits,
  page HTML, or screenshots. URL credentials/query strings/fragments are omitted.
  Selectors, URL paths, and errors are still potentially sensitive **untrusted page
  metadata**. Use authorized pages and review logs before sharing them. Events
  intercepted by the terminal never reach Dream and cannot be recorded.
- Done also saves a bounded **`activity.json`** beside that goal's PNG/manifest,
  so its troubleshooting context is not overwritten by later activity. Canceled
  Dreams retain the rolling log but do not publish a goal. Logs use owner-only
  permissions and atomic replacement; a storage failure is shown in Log and does
  not stop editing (the in-memory ring remains available).

Expected interactions such as a double-click on non-text show notices, not errors.
For other failures, Dream attempts to recapture the current page so stale selection
or menu graphics do not linger. You can click again or use **Refresh/Ctrl+R**; input
is not locked. **Ctrl+Q while an error is displayed** cancels an unusable Dream.
The Log view/file preserves the error even after the banner disappears. Logs cannot
recover events from sessions that ran before this feature was loaded.

### Saved goals and safety

Done posts the PNG into the Pi conversation, where the model can see it, and saves:

```text
<current working directory>/.pi/dreams/<timestamp>-<unique id>/goal.png
<current working directory>/.pi/dreams/<timestamp>-<unique id>/changes.json
<current working directory>/.pi/dreams/<timestamp>-<unique id>/activity.json
```

Add `.pi/dreams/` to your project's `.gitignore` if you don't want to version these
artifacts. No application source is changed. The manifest contains DOM selectors,
move/resize/deletion bounds, duplicate operations, and before/after edited text. Images, page text,
and edited field values can enter the transcript, artifact files, and model context;
**do not enter secrets**. Artifact directories/files use owner-only permissions
when created. Goals are viewport-only, not full-page captures or editable projects;
reopening a saved PNG/manifest does not reconstruct its DOM.

This is a **visual prototype**, not a general web design IDE. Movement uses CSS
translation and leaves original flex/grid flow/gaps intact. Resizing applies pixel
sizes (overriding relevant min/max and flex constraints); Undo restores the original
inline sizing and priorities. Copies are absolutely
positioned, with their captured styles/dimensions, not responsive layout rules.
Normal HTML and SVG icons inside HTML copies are supported. Iframes, shadow DOM,
custom elements, canvas/video/audio, and complex transformed layouts are not.
Text editing targets plain text (including `<br>` line breaks), not rich containers
with styled child elements. Copy is bounded to 500 DOM elements.

Selection never forwards a website click or follows a link. While Dream is active,
its early capture listeners suppress app click/submit/key/input handlers; ordinary
browser text/cursor defaults still work. **Page JavaScript continues running** and
can rerender away DOM edits or issue background requests. Dream is not an offline
snapshot or network sandbox. Use authorized sites; the same Chromium/network and
untrusted-page safety limitations as the browser tool apply.

Dream and inspection temporarily hide the background transcript's rendering so old
Kitty images cannot bleed through the modal, then restore the original transcript
on exit. They use Pi's renderer, not competing terminal graphics writes.

### Local Dream playground

```sh
npm run dream:demo                 # http://127.0.0.1:4174
```

In Pi, run `/dream http://127.0.0.1:4174`. Try changing the headline, duplicating the
CTA, dragging the duplicate, and choosing Parent on the card's title. The playground
binds to loopback; stop it with Ctrl+C. `PORT=4181 npm run dream:demo` selects another
port. It is separate from the inspection playground.

For a reproducible before/selection/goal gallery:

```sh
npm run dream:record -- http://127.0.0.1:4174
# View http://127.0.0.1:4174/result in your browser
```

The recorder feeds native mouse press/drag/release, double-click, Super+C/V, and
keyboard/paste sequences through Pi's actual fullscreen renderer into Dream and
Chromium. It saves PNGs, a changes report, and a static HTML viewer under the
ignored `artifacts/dream-demo/` directory. **This is not a human terminal recording
or an interactive web version of Dream.** It is calibrated to the playground.

## Agent actions

All actions use the same `browser` tool:

```json
{"action":"navigate","url":"http://localhost:3000"}
{"action":"click","target":{"role":"button","name":"Save"}}
{"action":"click","target":{"selector":"#save"}}
{"action":"click","target":{"x":640,"y":400}}
{"action":"fill","target":{"role":"textbox","name":"Email"},"text":"demo@example.com"}
{"action":"type","text":" appended text"}
{"action":"type","text":"multiline\ntext","paste":true}
{"action":"press","key":"Enter"}
{"action":"press","target":{"selector":"#search"},"key":"Enter"}
{"action":"scroll","deltaY":600}
{"action":"scroll","deltaY":400,"x":1000,"y":400}
{"action":"resize","width":390,"height":844}
{"action":"wait","ms":1000}
{"action":"screenshot"}
{"action":"back"}
{"action":"forward"}
{"action":"reload"}
{"action":"close"}
```

- Default viewport: **1280 × 800**, device scale factor 1. Screenshots are
  viewport-only; image coordinates match CSS pixel coordinates. Clicks must be
  inside the viewport. Resize is bounded to 320–2560 × 240–1600.
- Prefer exact accessible role/name targets or unique selectors. The result
  includes a bounded accessibility snapshot (12,000 characters) to help targeting.
  Roles: button, link, textbox, checkbox, radio, combobox, tab, menuitem, switch.
- `fill` replaces a field's content. `type` inserts into the focused field without
  replacing its value; `paste: true` uses literal text insertion for multiline
  paste. `press` uses Playwright key names and targets either the focused page
  control or the specified element.
- `scroll` sends a wheel event, optionally at a chosen viewport position for an
  inner scroll container. Reported scroll coordinates describe the main document.
- Navigation waits for `DOMContentLoaded`, followed by a short rendering delay,
  **not** all network requests. For delayed UI, explicitly wait (up to 10 seconds)
  or request another screenshot. There is no guarantee that a screenshot is an
  application's final loaded state.
- One page is active. New popups become active; tab selection is not implemented.
- Calls are sequential and share a browser context. Aborting a tool call closes
  the browser to interrupt Playwright operations; the next call creates a fresh one.
- Close, reload, shutdown, and session changes discard the browser profile.
  Session history/branch navigation does not rewind website state.
- PNGs are saved to a unique OS temporary directory and intentionally retained
  after browser shutdown for review. The OS may eventually remove them. Image
  blocks also live in the Pi transcript; this can grow large during long sessions.

## Safety and limitations

Websites execute JavaScript in Chromium. The extension uses a fresh profile with
no personal browser cookies or saved logins, enables Chromium's sandbox, blocks
service workers, cancels downloads, and dismisses JavaScript dialogs. It does not
ignore TLS certificate errors. HTTP(S) navigation supports localhost/private
networks deliberately; this is **not a hardened network or host isolation boundary**.
Do not use it to browse untrusted sites in an environment with sensitive services.

Navigation rejects local-file URLs, credential-bearing URLs, whitespace, and
terminal control characters. Page metadata is sanitized for terminal display;
page content is untrusted data, never instructions for the agent. Model guidelines
warn against following page instructions or performing consequential actions
without user authorization. Those guidelines are not a permissions enforcement
mechanism; existing Pi permission extensions can use the tool's destructive and
open-world annotations to request approval.

Tool arguments, page text, screenshots, and field values can be saved in sessions
and sent to the model provider. Avoid entering secrets without explicit permission.
Use an image-capable model and leave Pi's image handling enabled for visual review.
No persistent auth, arbitrary JavaScript evaluation tool, full-page screenshots,
multi-tab management, or live streaming. The regular browser/inspection controls
still do not implement dragging/double-click; those interactions belong to Dream's
DOM mockup editor. AI-generated goal images and source-code implementation/approval
workflows are not included.

## Development

```sh
npm run check
```

Checks TypeScript plus unit and real Chromium integration tests. Chromium must be
installed first. Integration tests run against a local HTTP fixture; they do not
need an external website or a model API key. They exercise screenshot encoding and
persistence, role/selector/coordinate clicks, typing, keyboard input, scrolling,
responsive resizing, navigation/history, popups, queuing, cancellation, and restart.
Inspection tests cover scaled hit-testing, terminal resize/cell metrics, supported
mode checks, toolbar actions, stale clicks, recovery, and cancellation. They also
feed SGR mouse press/release sequences through Pi's actual fullscreen renderer
into real Chromium to verify button clicks and link navigation. Native keyboard
and wheel tests also cover focusing fields, rapid typing during screenshot capture,
editing/select-all, Enter submission, Unicode multiline paste, and nested/page scrolling.
Dream tests exercise real DOM bounds, selection graphics, all eight resize handles,
selected-node identity checks, content-box/flex sizing, resize undo/redo/privacy,
terminal-cell handle targeting and native Pi resize gestures, group dragging, computed-style
copies, inline text/input editing, undo/redo, empty-wrapper ghost hit-testing,
painted/remaining-content targets, displaced-child dragging, profile isolation, artifact persistence,
mode guards, cancellation, and queue flushing before Done. They also exercise native
Pi double-click counts, mouse capture/drag sequences, and Super-key shortcuts into
Chromium, plus Kitty image suppression/restoration using Pi's real viewport tree.
Context-menu tests cover menu hit-testing, disabled actions, pointer-positioned paste,
viewport clamping, group duplication, keyboard navigation, dismissal and clean goal
capture. Native SGR right-click and menu-item clicks also run through Pi into Chromium.

```text
src/
  index.ts                 Tool/command registration and lifecycle cleanup
  browser/
    actions.ts             Action schema and inferred types
    backend.ts             Lazy Chromium lifecycle, serialized actions, PNG capture
    tool.ts                Agent instructions, model image results, transcript UI
    inspection-tool.ts     Agent-initiated user inspection
    url.ts                 Explicit HTTP(S) URL validation
  ui/
    browser-view.ts        Optional read-only user preview
    inspection.ts          Shared inspection lifecycle and mode guards
    inspection-view.ts     Modal controls, ordered input buffering, recovery/cancellation
    inspection-input.ts    Terminal key translation and chunked bracketed paste
    inspection-surface.ts  Native terminal image rendering and hit-testing
    opaque-modal.ts        Scoped transcript rendering suppression/restoration
    dream.ts               Dream lifecycle and mode guards
    dream-view.ts          DOM selection/editing controls and native drag capture
  dream/
    types.ts               Dream actions, frames, and result contracts
    editor.ts              Trusted browser-side DOM editor, copies, and undo history
    backend.ts             Separate Chromium profile and serialized Dream input
    artifacts.ts           Durable goal PNG and edit-manifest persistence
examples/
  inspection-demo.ts       Local browser controls playground (npm run demo)
  dream-demo.ts            Local Dream playground and recorded screenshot viewer
  record-dream-demo.ts     Reproducible Dream native-input screenshot harness
test/
  browser.test.ts           Unit tests
  chromium.test.ts          Browser integration tests and local fixture
  inspection.test.ts        Inspection UI, native mouse routing, lifecycle tests
  inspection-input.test.ts  Keyboard/paste protocol and shortcut tests
  dream.test.ts            DOM editor, native input, lifecycle, and artifact tests
  support.ts                Virtual terminal and fixture helpers
```

Pi's packages are peer dependencies; local dev copies support types and tests.
Playwright is a runtime dependency. No global Pi settings are changed by this project.

Next possibilities: user approval workflow, console/network diagnostics, robust
UI-ready checks, multi-tab support, richer Dream layout edits, saved DOM reconstruction,
and implementing source changes from an explicitly approved Dream goal.
