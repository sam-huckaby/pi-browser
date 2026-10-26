/** A deliberately ordinary HTML layout for Dream's first editing playground. */
export const dreamFixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Dream playground</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f6fc;color:#17213c;font-family:system-ui,-apple-system,sans-serif;min-height:1600px}
header{height:80px;border-bottom:1px solid #dde3f1;padding:24px 80px;display:flex;align-items:center;justify-content:space-between;background:#fff}
.logo{font-size:23px;font-weight:750;letter-spacing:-.7px}.logo b{color:#7954e8}nav{font-size:14px;color:#64708b;word-spacing:26px}
#eyebrow{position:absolute;left:80px;top:123px;font-size:13px;color:#7954e8;letter-spacing:2px;font-weight:700}
#headline{position:absolute;left:80px;top:157px;width:560px;height:112px;margin:0;font-size:48px;line-height:56px;letter-spacing:-2px;font-weight:750}
#subtitle{position:absolute;left:80px;top:301px;width:530px;height:62px;margin:0;font-size:20px;line-height:31px;color:#64708b}
#cta{position:absolute;left:80px;top:403px;width:180px;height:52px;border:0;border-radius:12px;background:#7954e8;color:white;font:650 16px system-ui;box-shadow:0 8px 20px #7954e828;cursor:pointer}
#card{position:absolute;left:765px;top:163px;width:350px;height:310px;padding:30px;border:1px solid #e1d9fa;border-radius:24px;background:linear-gradient(135deg,#eee7ff,#fff);box-shadow:0 24px 60px #26235414}
#card h2{margin:0 0 22px;font-size:22px;letter-spacing:-.6px}#card p{color:#64708b;font-size:15px;line-height:25px;margin:0 0 22px}
#card .metric{font-size:54px;color:#7954e8;font-weight:750;letter-spacing:-2px;margin:0}#card .caption{font-size:13px;color:#64708b;margin-top:4px}
.hint{position:absolute;left:80px;top:544px;width:1035px;padding:25px 30px;background:#fff;border:1px solid #e0e5f1;border-radius:18px;color:#64708b;font-size:15px;line-height:25px}
.hint strong{color:#17213c}#field{position:absolute;left:80px;top:800px;width:360px;height:50px;font:18px system-ui;padding:10px}
</style></head><body>
<header><div class="logo"><b>✦</b> Dream playground</div><nav>Product Stories About</nav></header>
<span id="eyebrow">MAKE ROOM FOR YOUR NEXT IDEA</span>
<h1 id="headline">A better first<br>impression.</h1>
<p id="subtitle">Start with the page you have. Shape the page you want.</p>
<button id="cta" onclick="window.appClicks++">Get started</button>
<div id="card"><h2>Small changes. Big impact.</h2><p>A clearer headline. A little more space. One well-placed call to action.</p><div class="metric">128%</div><div class="caption">More room to imagine.</div></div>
<div class="hint"><strong>Your canvas is the real page.</strong><br>Click to highlight · Drag to reposition · Selected handles resize · Copy and paste to duplicate · Double-click plain text to rewrite it.<br>Choose Parent to select a whole card. Done saves a clean screenshot; it does not change your source code.</div>
<input id="field" value="Editable input" aria-label="Example field">
<script>window.appClicks=0;window.appKeys=0;window.addEventListener('keydown',()=>window.appKeys++);</script>
</body></html>`;
