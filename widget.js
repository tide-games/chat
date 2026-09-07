// Tide Games chat widget — mount a NIP-28 room into any element.
//
//   import { mountChat } from 'https://tide-games.github.io/chat/widget.js';
//   const chat = mountChat(document.querySelector('#room'), {
//     relays: [...], channel: '<64-hex>', directory: 'https://nostr.social',
//     signer,            // { pubkey, sign(bytes) } (tidegate shape) or { pubkey, signEvent(ev) } (NIP-07)
//     height: 360,       // px; the log scrolls inside
//     onMessage(line),   // every line shown, history included: { id, pubkey, created_at, mine }
//   });
//   chat.setSigner(signer); chat.destroy();
//
// The host owns identity: hand in a signer and the room speaks as that key; hand
// in none and it reads. The widget never asks for a key, never touches
// localStorage except for the mute list, and carries its own scoped styles.
//
// A PRIVATE room: pass `secret` (64-hex, handed out by the host to members only).
// The channel id is derived from it and every line is NIP-44-encrypted with it,
// so the public relays carry ciphertext under an id outsiders cannot even
// guess. Lines that do not decrypt (a rotated key) are simply not shown.

const DEFAULTS = {
  relays: ['wss://relay.primal.net', 'wss://relay.damus.io', 'wss://nos.lol', 'wss://nostr.mom'],
  channel: 'b23bee14ecec248bbf04b18aedf48626dc36518d76a994f5413302659567f949',
  directory: 'https://nostr.social',
  history: 200,
  height: 360,
  muteKey: 'tide-chat-muted',
  bots: /^(Barnacle Bill|Coral Kate|Driftwood Dan|Kelpie|Old Wrack|Pearl Diver|Reef Rat|Saltmarsh Sam|Skerry Jack|Tide Turner|Gull Cry|Mangrove Mo|Nautilus Ned|Osprey|Puffin Pete|Quayside Quinn|Rockpool Rosa|Seagrass Sue|Trawler Tom|Undertow)$/,
};

const CSS = `
.tgchat{margin-bottom:28px;--tg-paper:#efe4c8;--tg-paper2:#e3d5b3;--tg-ink:#2a2216;--tg-soft:#5c4f3a;--tg-line:#c9b891;--tg-teal:#3e8f8a;--tg-gold:#8a6508;--tg-red:#a63d3d;--tg-field:#fff9ea;
  display:flex;flex-direction:column;border:1px solid var(--tg-line);border-radius:10px;background:linear-gradient(#f3e9d0,var(--tg-paper) 40%,var(--tg-paper2));color:var(--tg-ink);font-family:Georgia,'Times New Roman',serif;font-size:14px;min-height:0;overflow:hidden}
.tgchat *{box-sizing:border-box;margin:0}
.tgchat .tg-log{flex:1;overflow-y:auto;padding:10px 14px;min-height:0;scroll-behavior:smooth}
.tgchat .tg-msg{display:grid;grid-template-columns:44px 1fr;gap:8px;padding:4px 0;border-bottom:1px dotted #d7c9a4}
.tgchat .tg-t{color:var(--tg-soft);font-size:11px;padding-top:3px;font-variant-numeric:tabular-nums}
.tgchat .tg-n{font-weight:700;color:var(--tg-teal);text-decoration:none}
.tgchat .tg-n:hover{text-decoration:underline}
.tgchat .tg-n.tg-me{color:var(--tg-gold)}
.tgchat .tg-n.tg-bot{color:var(--tg-red)}
.tgchat .tg-c{white-space:pre-wrap;word-break:break-word}
.tgchat .tg-mute{margin-left:8px;font:inherit;font-size:10px;padding:0 6px;border:1px solid var(--tg-line);border-radius:4px;background:transparent;color:var(--tg-soft);opacity:0;cursor:pointer;vertical-align:1px}
.tgchat .tg-msg:hover .tg-mute,.tgchat .tg-mute:focus-visible{opacity:1}
@media (hover:none){.tgchat .tg-mute{opacity:.6}}
.tgchat .tg-msg.tg-muted > *{display:none}
.tgchat .tg-msg.tg-muted{display:block;padding:2px 0}
.tgchat .tg-stub{display:inline;background:none;border:0;color:var(--tg-soft);font:inherit;font-size:11px;font-style:italic;padding:0;cursor:pointer}
.tgchat .tg-stub:hover{text-decoration:underline}
.tgchat .tg-sys{color:var(--tg-soft);font-style:italic;font-size:12px;padding:6px 0;text-align:center}
.tgchat .tg-bar{display:flex;gap:8px;align-items:center;padding:8px 12px;border-top:1px solid var(--tg-line);background:var(--tg-paper2)}
.tgchat .tg-bar textarea{flex:1;font:inherit;font-size:14px;resize:none;height:38px;padding:8px 10px;border:1px solid var(--tg-line);border-radius:8px;background:var(--tg-field);color:var(--tg-ink)}
.tgchat .tg-bar textarea:disabled{background:#ede2c6;color:#8a7c60}
.tgchat .tg-bar button{font:inherit;cursor:pointer;border-radius:6px;border:1px solid var(--tg-gold);background:linear-gradient(#e9d8a8,#c9a24b);color:var(--tg-ink);padding:6px 12px}
.tgchat .tg-bar button:disabled{opacity:.5;cursor:default}
.tgchat .tg-foot{display:flex;gap:10px;justify-content:space-between;align-items:center;padding:4px 12px 6px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:11px;color:var(--tg-soft);background:var(--tg-paper2)}
.tgchat .tg-foot a{color:var(--tg-teal);text-decoration:none}
.tgchat .tg-relays i{display:inline-block;width:7px;height:7px;border-radius:50%;background:#999;margin-right:3px}
.tgchat .tg-relays i.on{background:#3f9d5a}
.tgchat .tg-relays i.off{background:#c55}
`;

function ensureStyle() {
  if (document.getElementById('tgchat-style')) return;
  const st = document.createElement('style'); st.id = 'tgchat-style'; st.textContent = CSS; document.head.appendChild(st);
}

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const short = (pk) => pk.slice(0, 8) + '…' + pk.slice(-4);
const hhmm = (ts) => new Date(ts * 1000).toTimeString().slice(0, 5);
async function sha256(bytes) { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); }

const utf8 = (s) => new TextEncoder().encode(s);
const fromHex = (h) => Uint8Array.from(h.match(/.{2}/g), (b) => parseInt(b, 16));
let _nip44 = null;
async function nip44() {
  if (_nip44) return _nip44;
  const m = await import('https://esm.sh/nostr-tools@2.7.2/nip44');
  _nip44 = m.v2 || m.default || m;
  return _nip44;
}

export function mountChat(container, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const isPrivate = /^[0-9a-f]{64}$/.test(o.secret || '');
  const roomKey = isPrivate ? fromHex(o.secret) : null;
  ensureStyle();
  container.innerHTML = '';
  const root = document.createElement('div'); root.className = 'tgchat'; root.style.height = typeof o.height === 'number' ? o.height + 'px' : o.height;
  root.innerHTML = `
    <div class="tg-log"><div class="tg-sys">listening to the relays…</div></div>
    <form class="tg-bar"><textarea maxlength="1000" placeholder="${(o.readOnlyHint || 'Reading only — no key to speak with').replace(/"/g, '&quot;')}" disabled></textarea><button type="submit" disabled>Say</button></form>
    <div class="tg-foot"><span class="tg-relays"></span><span class="tg-muteinfo"></span><a class="tg-open" target="_blank" rel="noopener">open the room ↗</a></div>`;
  container.appendChild(root);
  const $ = (s) => root.querySelector(s);
  const log = $('.tg-log'), form = $('.tg-bar'), ta = $('.tg-bar textarea'), sendBtn = $('.tg-bar button');
  $('.tg-open').href = 'https://tide-games.github.io/chat/';
  if (isPrivate) $('.tg-open').remove(); // a private room has no public page

  // ------------------------------------------------------------ state
  const sockets = new Map(), acks = new Map(), seen = new Set(), pending = [];
  const names = new Map(), asking = new Set(), profiles = new Map();
  let signer = null, me = null, firstFlush = true, alive = true;

  // ------------------------------------------------------------ relays
  function status() {
    $('.tg-relays').innerHTML = o.relays.map((u) => {
      const ws = sockets.get(u); const on = ws && ws.readyState === 1;
      return `<i class="${on ? 'on' : 'off'}" title="${u}"></i>`;
    }).join('');
  }
  function connect(url) {
    if (!alive) return;
    let ws; try { ws = new WebSocket(url); } catch { return; }
    sockets.set(url, ws);
    ws.onopen = () => {
      ws.send(JSON.stringify(['REQ', 'room', { kinds: [42], '#e': [o.channel], limit: o.history }]));
      for (const pk of unresolved) askProfile(ws, pk);
      status();
    };
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(m.data); } catch { return; }
      if (msg[0] === 'EVENT') onEvent(msg[2]);
      if (msg[0] === 'EOSE' && msg[1] === 'room') flush(true);
      if (msg[0] === 'OK') { const cb = acks.get(msg[1]); if (cb) cb(url, !!msg[2], msg[3] || ''); }
    };
    ws.onclose = () => { status(); if (alive) setTimeout(() => connect(url), 5000 + Math.random() * 5000); };
    ws.onerror = () => status();
  }
  async function onEvent(ev) {
    if (!ev || typeof ev.id !== 'string' || seen.has(ev.id)) return;
    if (ev.kind === 0) return onProfile(ev);
    if (ev.kind !== 42) return;
    if (!ev.tags.some((t) => t[0] === 'e' && t[1] === o.channel)) return;
    seen.add(ev.id);
    if (isPrivate) {
      try { const n = await nip44(); ev = { ...ev, content: n.decrypt(ev.content, roomKey) }; }
      catch { return; } // another key's line (rotated, or not ours): not shown
    }
    pending.push(ev); wantName(ev.pubkey); flush(false);
  }

  // ------------------------------------------------------------ names
  async function wantName(pk) {
    if (names.has(pk) || asking.has(pk)) return;
    asking.add(pk);
    let name = null;
    try {
      const r = await fetch(`${o.directory}/api/profile/${pk}`);
      const p = r.ok ? await r.json() : null;
      if (p && (p.display_name || p.name)) name = p.display_name || p.name;
    } catch { /* directory down */ }
    if (!name) { unresolved.add(pk); for (const ws of sockets.values()) askProfile(ws, pk); }
    names.set(pk, name || short(pk)); asking.delete(pk); rerenderNames(pk);
  }
  // A relay that opens late still gets asked for every name we lack.
  const unresolved = new Set();
  function askProfile(ws, pk) { if (ws.readyState === 1) ws.send(JSON.stringify(['REQ', 'p-' + pk.slice(0, 8), { kinds: [0], authors: [pk], limit: 1 }])); }
  function onProfile(ev) {
    try {
      const p = JSON.parse(ev.content);
      const have = profiles.get(ev.pubkey);
      if (!have || have.created_at < ev.created_at) profiles.set(ev.pubkey, { content: p, created_at: ev.created_at });
      const n = p.display_name || p.name;
      if (n && (!names.has(ev.pubkey) || names.get(ev.pubkey) === short(ev.pubkey) || ev.pubkey === me)) { names.set(ev.pubkey, n); unresolved.delete(ev.pubkey); rerenderNames(ev.pubkey); }
    } catch { /* ignore */ }
  }
  function rerenderNames(pk) {
    root.querySelectorAll(`.tg-n[data-pk="${pk}"]`).forEach((el) => { el.textContent = names.get(pk); el.classList.toggle('tg-bot', o.bots.test(names.get(pk))); });
  }

  // ------------------------------------------------------------ mute
  function muted() { try { return new Set(JSON.parse(localStorage.getItem(o.muteKey) || '[]')); } catch { return new Set(); } }
  function toggleMute(pk) {
    const m = muted(); if (m.has(pk)) m.delete(pk); else m.add(pk);
    try { localStorage.setItem(o.muteKey, JSON.stringify([...m])); } catch { /* private mode */ }
    applyMutes();
  }
  function applyMutes() {
    const m = muted();
    root.querySelectorAll('.tg-msg').forEach((el) => {
      const isMuted = m.has(el.dataset.pk);
      el.classList.toggle('tg-muted', isMuted);
      let stub = el.querySelector('.tg-stub');
      if (isMuted && !stub) {
        stub = document.createElement('button'); stub.type = 'button'; stub.className = 'tg-stub';
        stub.textContent = `muted ${names.get(el.dataset.pk) || short(el.dataset.pk)} — show`;
        stub.addEventListener('click', () => toggleMute(el.dataset.pk)); el.appendChild(stub);
      } else if (!isMuted && stub) stub.remove();
    });
    const info = $('.tg-muteinfo'); info.textContent = '';
    if (m.size) {
      info.appendChild(document.createTextNode(`${m.size} muted · `));
      const a = document.createElement('a'); a.href = '#'; a.textContent = 'unmute all';
      a.addEventListener('click', (e) => { e.preventDefault(); try { localStorage.removeItem(o.muteKey); } catch { /* ok */ } applyMutes(); });
      info.appendChild(a);
    }
  }

  // ------------------------------------------------------------ render
  function sys(text) { const d = document.createElement('div'); d.className = 'tg-sys'; d.textContent = text; log.appendChild(d); scroll(); }
  function scroll() { log.scrollTop = log.scrollHeight; }
  function flush(eose) {
    if (firstFlush && (pending.length || eose)) { log.textContent = ''; firstFlush = false; }
    if (!pending.length) {
      if (eose && !log.querySelector('.tg-msg') && !log.querySelector('.tg-empty')) { const d = document.createElement('div'); d.className = 'tg-sys tg-empty'; d.textContent = 'nobody has spoken yet — be the first'; log.appendChild(d); }
      return;
    }
    log.querySelectorAll('.tg-empty').forEach((el) => el.remove());
    pending.sort((a, b) => a.created_at - b.created_at);
    for (const ev of pending.splice(0)) {
      const row = document.createElement('div'); row.className = 'tg-msg'; row.dataset.pk = ev.pubkey; row.dataset.ts = ev.created_at;
      const t = document.createElement('span'); t.className = 'tg-t'; t.textContent = hhmm(ev.created_at);
      const body = document.createElement('div');
      const n = document.createElement('a'); n.className = 'tg-n'; n.dataset.pk = ev.pubkey;
      n.textContent = names.get(ev.pubkey) || short(ev.pubkey); n.href = `${o.directory}/${ev.pubkey}`; n.target = '_blank'; n.rel = 'noopener noreferrer'; n.title = ev.pubkey;
      if (ev.pubkey === me) n.classList.add('tg-me');
      if (o.bots.test(n.textContent)) n.classList.add('tg-bot');
      const c = document.createElement('div'); c.className = 'tg-c'; c.textContent = ev.content;
      body.appendChild(n);
      if (ev.pubkey !== me) { const mb = document.createElement('button'); mb.type = 'button'; mb.className = 'tg-mute'; mb.textContent = 'mute'; mb.addEventListener('click', () => toggleMute(ev.pubkey)); body.appendChild(mb); }
      body.appendChild(c); row.appendChild(t); row.appendChild(body);
      let after = null;
      for (const el of log.querySelectorAll('.tg-msg')) { if (Number(el.dataset.ts) > ev.created_at) { after = el; break; } }
      log.insertBefore(row, after);
      if (typeof o.onMessage === 'function') { try { o.onMessage({ id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at, mine: ev.pubkey === me }); } catch { /* the host's problem */ } }
    }
    applyMutes(); scroll();
  }

  // ------------------------------------------------------------ speaking
  async function publish(kind, tags, content) {
    if (!signer || !me) throw new Error('no signer');
    const ev = { pubkey: me, created_at: Math.floor(Date.now() / 1000), kind, tags, content };
    const ser = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
    const bytes = new TextEncoder().encode(ser);
    ev.id = hex(await sha256(bytes));
    if (signer.signEvent) { const s = await signer.signEvent(ev); ev.sig = s.sig; ev.id = s.id; }
    else ev.sig = await signer.sign(bytes);
    const live = [...sockets.entries()].filter(([, ws]) => ws.readyState === 1);
    if (!live.length) throw new Error('no relay is connected');
    const ok = [], refused = [];
    const done = new Promise((resolve) => {
      const finish = () => { acks.delete(ev.id); resolve(); };
      const timer = setTimeout(finish, 4000);
      acks.set(ev.id, (url, accepted, reason) => { (accepted ? ok : refused).push(accepted ? url : [url, reason]); if (ok.length + refused.length >= live.length) { clearTimeout(timer); finish(); } });
    });
    for (const [, ws] of live) ws.send(JSON.stringify(['EVENT', ev]));
    await done;
    return { ev, ok, refused };
  }
  async function say(text) {
    const wire = isPrivate ? (await nip44()).encrypt(text, roomKey) : text;
    const { ev, ok, refused } = await publish(42, [['e', o.channel, o.relays[0], 'root']], wire);
    onEvent(ev);
    if (!ok.length) sys('no relay accepted that: ' + refused.map(([u, r]) => u.replace('wss://', '') + ' — ' + r).join('; '));
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = ta.value.trim(); if (!text || !me) return;
    sendBtn.disabled = true;
    try { await say(text); ta.value = ''; } catch (err) { sys('could not send: ' + (err.message || err)); }
    sendBtn.disabled = false; ta.focus();
  });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });

  // ------------------------------------------------------------ identity (the host's)
  function setSigner(s) {
    signer = s || null; me = s ? s.pubkey : null;
    ta.disabled = !me; sendBtn.disabled = !me;
    ta.placeholder = me ? 'Say something to the fleet…' : (o.readOnlyHint || 'Reading only — no key to speak with');
    if (me) wantName(me);
    root.querySelectorAll('.tg-n').forEach((el) => el.classList.toggle('tg-me', el.dataset.pk === me));
  }

  // ------------------------------------------------------------ boot
  (async () => {
    if (isPrivate) o.channel = hex(await sha256(utf8('tide-chat-room|' + o.secret))); // the room's id, from its key
    for (const url of o.relays) connect(url);
    status();
    if (o.signer) setSigner(o.signer);
  })();

  return {
    el: root,
    setSigner,
    publishProfile: (profile) => publish(0, [], JSON.stringify(profile)),
    currentProfile: () => (me && profiles.get(me)) ? profiles.get(me).content : null,
    requestProfile: () => { if (me) for (const ws of sockets.values()) if (ws.readyState === 1) ws.send(JSON.stringify(['REQ', 'me-0', { kinds: [0], authors: [me], limit: 1 }])); },
    names,
    scrollToEnd: scroll,   // a room mounted hidden cannot scroll until shown
    destroy() { alive = false; for (const ws of sockets.values()) { try { ws.close(); } catch { /* closed */ } } container.innerHTML = ''; },
  };
}
