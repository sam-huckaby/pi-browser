/** Mirrors the docs page's transparent button/span wrappers around an avatar. */
export const ghostFixture = `<!doctype html><html><head><meta charset="utf-8"><title>Dream ghost regression</title><style>
body{margin:0;background:#f4f6fc;color:#17213c;font:16px system-ui;height:1200px}h1{position:absolute;left:80px;top:50px;font-size:32px}p{position:absolute;left:80px;top:120px;color:#64708b}
#underlay{position:absolute;left:100px;top:200px;width:120px;height:80px;background:#dfe7ff;border-radius:10px;display:flex;align-items:flex-end;padding:8px;box-sizing:border-box;font-size:12px}
#row{position:absolute;left:100px;top:200px;width:120px;height:80px}#slot{display:inline-flex}#avatar-button{display:block;width:28px;height:28px;padding:0;border:2px solid white;border-radius:50%;background:transparent;cursor:pointer}#image-wrapper{display:block;width:24px;height:24px}#avatar{display:block;width:24px;height:24px;border-radius:50%}
</style></head><body><h1>Moved avatars should not leave selectable ghosts.</h1><p>The transparent wrappers stay in layout; selection must follow the visible content.</p>
<div id="underlay">Underlying panel</div><div id="row"><span id="slot"><button id="avatar-button"><span id="image-wrapper"><img id="avatar" alt="Avatar" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Crect width='24' height='24' fill='%23ff6b19'/%3E%3Ccircle cx='12' cy='8' r='4' fill='white'/%3E%3Cpath d='M4 22a8 8 0 0116 0' fill='white'/%3E%3C/svg%3E"></span></button></span></div>
</body></html>`;
