import { createServer } from "node:http";

/** Local browser controls playground: clicks, fields, paste, and nested scrolling. */
const server = createServer((request, response) => {
  const details = request.url?.startsWith("/details") ?? false;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pi browser · ${details ? "Details" : "Inspection playground"}</title>
<style>
  * { box-sizing:border-box; } body { margin:0; font:18px system-ui; background:#101827; color:#eaf0ff; }
  main { max-width:1080px; margin:55px auto; padding:0 36px; }
  .eyebrow { color:#80b4ff; text-transform:uppercase; font-size:14px; letter-spacing:3px; }
  h1 { font-size:46px; margin:12px 0; } .subtitle { color:#aab8d0; line-height:1.6; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:24px; margin:30px 0; }
  .card { min-width:0; padding:28px; background:#1c2940; border:1px solid #354768; border-radius:18px; }
  h2 { margin:0 0 12px; font-size:23px; } #count { display:block; font-size:70px; margin:12px 0; }
  button,a { display:inline-block; font:600 18px system-ui; padding:16px 24px; border:0; border-radius:10px; background:#75aaff; color:#08162e; text-decoration:none; cursor:pointer; margin:6px 8px 6px 0; }
  #status { padding:20px; border-radius:12px; background:#133e35; color:#89ebc1; }
  label { display:block; margin:18px 0 8px; } input,textarea { display:block; width:100%; padding:14px; font:20px system-ui; background:#101827; color:#eaf0ff; border:2px solid #75aaff; border-radius:10px; }
  textarea { height:130px; } .scrollbox { height:220px; overflow:auto; border:2px solid #75aaff; border-radius:10px; }
  .scrollbox div { width:800px; padding:12px 24px; } .scrollbox p { padding:10px; border-bottom:1px solid #354768; }
  body.light input,body.light textarea { background:#eef3fb; color:#142138; }
  body.light { background:#eef3fb; color:#142138; } body.light .card { background:white; }
  @media(max-width:700px) { .grid { grid-template-columns:1fr; } main { margin:25px auto; } h1 { font-size:32px; } }
</style></head><body><main>
<div class="eyebrow">pi-browser / inspection</div>
<h1>${details ? "You navigated to another page" : "Inspection playground"}</h1>
<p class="subtitle">Click directly on the page inside Pi. Each click updates Chromium and refreshes the screenshot.</p>
<div class="grid">
  <section class="card"><h2>Try a button</h2><span id="count">0</span>
  <button id="increase">Increase +</button><button id="reset">Reset</button>
  <form id="greeting"><label for="name">Name</label><input id="name" autocomplete="off" placeholder="Click here and type"><button type="submit">Submit greeting</button></form></section>
  <section class="card"><h2>Try appearance and navigation</h2>
  <p class="subtitle">These are real website controls, not Pi UI controls.</p>
  <button id="theme">Change theme</button><br>
  <a href="${details ? "/" : "/details"}">${details ? "Back to playground" : "Open details page →"}</a></section>
</div>
<p id="status">Ready for your first click.</p>
<div class="grid">
  <section class="card"><h2>Try text editing and paste</h2><label for="notes">Notes</label><textarea id="notes" placeholder="Type or paste multiple lines here"></textarea>
  <p class="subtitle">Use Tab, Shift+Tab, Backspace, Delete, arrow keys, and Ctrl/Cmd+A just like a browser.</p></section>
  <section class="card"><h2>Try nested scrolling</h2><p class="subtitle">Scroll with your pointer inside this panel. Shift+wheel scrolls horizontally.</p>
  <div class="scrollbox"><div>${Array.from({ length: 16 }, (_, i) => `<p>Panel row ${i + 1} · scroll down for more · far-right content →</p>`).join("")}</div></div></section>
</div>
<p class="subtitle">Use Pi's Refresh button or Ctrl+R for delayed updates. Press Esc or Done when finished.</p>
</main><script>
let count = Number(sessionStorage.getItem('count') || 0);
const status = document.querySelector('#status');
const update = () => { document.querySelector('#count').textContent = count; sessionStorage.setItem('count', String(count)); };
update();
document.querySelector('#increase').onclick = () => { count++; update(); status.textContent = 'Click received! Counter is now ' + count + '.'; };
document.querySelector('#reset').onclick = () => { count = 0; update(); status.textContent = 'Counter reset.'; };
document.querySelector('#theme').onclick = () => { document.body.classList.toggle('light'); status.textContent = 'Theme changed.'; };
document.querySelector('#name').oninput = (event) => { status.textContent = 'Typing received: ' + event.target.value; };
document.querySelector('#greeting').onsubmit = (event) => { event.preventDefault(); status.textContent = 'Hello ' + document.querySelector('#name').value + '! Form submitted locally.'; };
</script></body></html>`);
});

const port = Number(process.env.PORT ?? 4173);
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") console.log(`Inspection demo: http://127.0.0.1:${address.port}`);
});
server.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close());
