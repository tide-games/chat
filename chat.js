// Tide Games chat — a NIP-28 public channel, standalone. No build, no server:
// the page talks to public relays directly and signs with the player's own key.
//
// Knobs (query string wins, so a season or a test can point elsewhere):
//   ?relay=wss://a,wss://b   relays to read from and write to
//   ?channel=<64-hex>        the kind-40 channel event id
//   ?directory=<origin>      where names are looked up (nostr.social by default)

const q = new URLSearchParams(location.search);
// Order matters a little: the first relay is the hint carried in every
// message's channel tag. Primal and Damus take events from any key; nos.lol
// and nostr.mom answer "not acceptable at this point" to chat from keys they
// do not trust (a kind-0 profile alone does not change their mind — tested);
// they still serve as readers.
const RELAYS = (q.get('relay') || 'wss://relay.primal.net,wss://relay.damus.io,wss://nos.lol,wss://nostr.mom')
  .split(',').map((s) => s.trim()).filter(Boolean);
const CHANNEL = (q.get('channel') || 'b23bee14ecec248bbf04b18aedf48626dc36518d76a994f5413302659567f949').toLowerCase();
const DIRECTORY = (q.get('directory') || 'https://nostr.social').replace(/\/+$/, '');
const KEYS_URL = 'https://melvincarvalho.github.io/tidegate/keys.js';
const MUTE_KEY = 'tide-chat-muted';
const HISTORY = 200;

const $ = (s) => document.querySelector(s);
const log = $('#log');
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const short = (pk) => pk.slice(0, 8) + '…' + pk.slice(-4);
const hhmm = (ts) => new Date(ts * 1000).toTimeString().slice(0, 5);

// ---------------------------------------------------------------- relays
const sockets = new Map();   // url -> WebSocket
const acks = new Map();      // event id -> (relay, accepted, reason) while a publish is in flight
const seen = new Set();      // event ids already rendered
const pending = [];          // events waiting for names before render
let signer = null;           // { pubkey, sign(bytes) } — tidegate shape
let me = null;               // my pubkey, once signed in

function status() {
  const el = $('#status');
  el.innerHTML = RELAYS.map((u) => {
    const ws = sockets.get(u);
    const on = ws && ws.readyState === 1;
    return `<span class="r ${on ? 'on' : 'off'}"><i></i>${u.replace('wss://', '')}</span>`;
  }).join('') + ` <a href="https://nostr.social/relays" target="_blank" rel="noopener">relays ↗</a>`;
}

function connect(url) {
  let ws;
  try { ws = new WebSocket(url); } catch { return; }
  sockets.set(url, ws);
  ws.onopen = () => {
    ws.send(JSON.stringify(['REQ', 'chan', { ids: [CHANNEL], kinds: [40] }]));
    ws.send(JSON.stringify(['REQ', 'room', { kinds: [42], '#e': [CHANNEL], limit: HISTORY }]));
    status();
  };
  ws.onmessage = (m) => {
    let msg; try { msg = JSON.parse(m.data); } catch { return; }
    if (msg[0] === 'EVENT') onEvent(msg[2], url);
    if (msg[0] === 'EOSE' && msg[1] === 'room') flush(true);
    if (msg[0] === 'OK') { const cb = acks.get(msg[1]); if (cb) cb(url, !!msg[2], msg[3] || ''); }
  };
  ws.onclose = () => { status(); setTimeout(() => connect(url), 5000 + Math.random() * 5000); };
  ws.onerror = () => status();
}

function onEvent(ev, from) {
  if (!ev || typeof ev.id !== 'string' || seen.has(ev.id)) return;
  if (ev.kind === 0) return onProfile(ev);
  if (ev.kind === 40) {
    try { const meta = JSON.parse(ev.content); $('#chan-name').textContent = meta.name || short(ev.id); } catch { /* keep */ }
    return;
  }
  if (ev.kind !== 42) return;
  if (!ev.tags.some((t) => t[0] === 'e' && t[1] === CHANNEL)) return;
  seen.add(ev.id);
  pending.push(ev);
  wantName(ev.pubkey);
  flush(false);
}

// ---------------------------------------------------------------- names
// A pubkey is a player. The directory knows the fleet's identities; kind-0
// profiles on the relays cover everyone else; a short key is the honest
// fallback. Names are cached for the session only.
const names = new Map();
const asking = new Set();
const KNOWN_BOTS = /^(Barnacle Bill|Coral Kate|Driftwood Dan|Kelpie|Old Wrack|Pearl Diver|Reef Rat|Saltmarsh Sam|Skerry Jack|Tide Turner|Gull Cry|Mangrove Mo|Nautilus Ned|Osprey|Puffin Pete|Quayside Quinn|Rockpool Rosa|Seagrass Sue|Trawler Tom|Undertow)$/;

async function wantName(pk) {
  if (names.has(pk) || asking.has(pk)) return;
  asking.add(pk);
  let name = null;
  try {
    const r = await fetch(`${DIRECTORY}/api/profile/${pk}`);
    const p = r.ok ? await r.json() : null;
    if (p && (p.display_name || p.name)) name = p.display_name || p.name;
  } catch { /* directory down — relays next */ }
  if (!name) {
    for (const ws of sockets.values()) {
      if (ws.readyState === 1) ws.send(JSON.stringify(['REQ', 'p-' + pk.slice(0, 8), { kinds: [0], authors: [pk], limit: 1 }]));
    }
  }
  names.set(pk, name || short(pk));
  asking.delete(pk);
  rerenderNames(pk);
}
// kind-0 answers to the name requests above arrive like any other event.
const profiles = new Map();  // pubkey -> { content, created_at } — the newest kind-0 seen
function onProfile(ev) {
  try {
    const p = JSON.parse(ev.content);
    const have = profiles.get(ev.pubkey);
    if (!have || have.created_at < ev.created_at) profiles.set(ev.pubkey, { content: p, created_at: ev.created_at });
    const n = p.display_name || p.name;
    if (n && (!names.has(ev.pubkey) || names.get(ev.pubkey) === short(ev.pubkey) || ev.pubkey === me)) { names.set(ev.pubkey, n); rerenderNames(ev.pubkey); }
  } catch { /* ignore */ }
}
function rerenderNames(pk) {
  document.querySelectorAll(`.n[data-pk="${pk}"], #who .me[data-pk="${pk}"]`).forEach((el) => { el.textContent = names.get(pk); el.classList.toggle('bot', KNOWN_BOTS.test(names.get(pk))); });
}

// ---------------------------------------------------------------- mute
function muted() { try { return new Set(JSON.parse(localStorage.getItem(MUTE_KEY) || '[]')); } catch { return new Set(); } }
function toggleMute(pk) {
  const m = muted();
  if (m.has(pk)) m.delete(pk); else m.add(pk);
  try { localStorage.setItem(MUTE_KEY, JSON.stringify([...m])); } catch { /* private mode */ }
  applyMutes();
  sys(m.has(pk) ? `muted ${names.get(pk) || short(pk)} — click the name again to unmute` : `unmuted ${names.get(pk) || short(pk)}`);
}
// A muted line collapses to a stub rather than vanishing, so the way back is
// always on screen; a header control lists how many are muted and clears them.
function applyMutes() {
  const m = muted();
  document.querySelectorAll('.msg').forEach((el) => {
    const isMuted = m.has(el.dataset.pk);
    el.classList.toggle('muted', isMuted);
    let stub = el.querySelector('.stub');
    if (isMuted && !stub) {
      stub = document.createElement('button'); stub.type = 'button'; stub.className = 'stub';
      stub.textContent = `muted ${names.get(el.dataset.pk) || short(el.dataset.pk)} — show`;
      stub.addEventListener('click', () => toggleMute(el.dataset.pk));
      el.appendChild(stub);
    } else if (!isMuted && stub) stub.remove();
  });
  const bar = $('#mutebar');
  if (bar) {
    bar.hidden = m.size === 0;
    if (m.size) bar.textContent = '';
    if (m.size) {
      bar.appendChild(document.createTextNode(`${m.size} muted · `));
      const a = document.createElement('a'); a.href = '#'; a.textContent = 'unmute all';
      a.addEventListener('click', (e) => { e.preventDefault(); try { localStorage.removeItem(MUTE_KEY); } catch { /* ok */ } applyMutes(); sys('everyone is unmuted'); });
      bar.appendChild(a);
    }
  }
}

// ---------------------------------------------------------------- render
function sys(text) {
  const d = document.createElement('div'); d.className = 'sys'; d.textContent = text; log.appendChild(d); scroll();
}
function scroll() { log.scrollTop = log.scrollHeight; }

let firstFlush = true;
function flush(eose) {
  if (firstFlush && (pending.length || eose)) { log.textContent = ''; firstFlush = false; }
  if (!pending.length) {
    // every relay sends its own end-of-history; say "empty" once, and only while it is
    if (eose && !log.querySelector('.msg') && !log.querySelector('.sys.empty')) {
      const d = document.createElement('div'); d.className = 'sys empty'; d.textContent = 'nobody has spoken yet — be the first'; log.appendChild(d);
    }
    return;
  }
  log.querySelectorAll('.sys.empty').forEach((el) => el.remove());
  pending.sort((a, b) => a.created_at - b.created_at);
  for (const ev of pending.splice(0)) {
    const row = document.createElement('div');
    row.className = 'msg'; row.dataset.pk = ev.pubkey; row.dataset.ts = ev.created_at;
    const t = document.createElement('span'); t.className = 't'; t.textContent = hhmm(ev.created_at);
    const body = document.createElement('div');
    const n = document.createElement('span'); n.className = 'n'; n.dataset.pk = ev.pubkey;
    n.textContent = names.get(ev.pubkey) || short(ev.pubkey);
    if (ev.pubkey === me) n.classList.add('me');
    if (KNOWN_BOTS.test(n.textContent)) n.classList.add('bot');
    // your own name opens your profile; anyone else's mutes (a stub stays to undo it)
    n.title = ev.pubkey === me ? 'you — edit your profile' : ev.pubkey + ' — click to mute';
    n.addEventListener('click', () => { if (n.dataset.pk === me) openProfile(); else toggleMute(n.dataset.pk); });
    const c = document.createElement('div'); c.className = 'c'; c.textContent = ev.content;
    body.appendChild(n); body.appendChild(c);
    row.appendChild(t); row.appendChild(body);
    // keep chronological order even when relays answer out of turn
    let after = null;
    for (const el of log.querySelectorAll('.msg')) { if (Number(el.dataset.ts) > ev.created_at) { after = el; break; } }
    log.insertBefore(row, after);
  }
  applyMutes();
  scroll();
}

// ---------------------------------------------------------------- speaking
async function sha256(bytes) { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); }

// Sign an event with whoever is signed in, send it to every connected relay,
// and wait (briefly) for their answers. Resolves { ev, ok: [urls], refused: [[url, reason]] }.
async function publish(kind, tags, content) {
  const ev = { pubkey: me, created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  const ser = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
  const bytes = new TextEncoder().encode(ser);
  ev.id = hex(await sha256(bytes));
  if (signer.signEvent) {
    const signed = await signer.signEvent(ev);     // NIP-07: the extension signs
    ev.sig = signed.sig; ev.id = signed.id;
  } else {
    ev.sig = await signer.sign(bytes);             // tidegate: schnorr(sha256(bytes)) = schnorr(id)
  }
  const live = [...sockets.entries()].filter(([, ws]) => ws.readyState === 1);
  if (!live.length) throw new Error('no relay is connected');
  const ok = [], refused = [];
  const done = new Promise((resolve) => {
    const finish = () => { acks.delete(ev.id); resolve(); };
    const timer = setTimeout(finish, 4000);
    acks.set(ev.id, (url, accepted, reason) => {
      (accepted ? ok : refused).push(accepted ? url : [url, reason]);
      if (ok.length + refused.length >= live.length) { clearTimeout(timer); finish(); }
    });
  });
  for (const [, ws] of live) ws.send(JSON.stringify(['EVENT', ev]));
  await done;
  return { ev, ok, refused };
}

async function say(text) {
  const { ev, ok, refused } = await publish(42, [['e', CHANNEL, RELAYS[0], 'root']], text);
  onEvent(ev, 'self'); // show at once; relays echo the same id and are deduped
  if (!ok.length) sys('no relay accepted that: ' + refused.map(([u, r]) => u.replace('wss://', '') + ' — ' + r).join('; '));
}

// ---------------------------------------------------------------- profile (kind 0)
// The newest profile we know for the signed-in key is loaded FIRST, so someone
// arriving with a real nostr identity (NIP-07) edits their profile rather than
// wiping it. Unknown fields ride along untouched.
async function openProfile() {
  const dlg = $('#profile');
  const have = profiles.get(me);
  if (!have) {
    // ask the relays and the directory, then give them a moment
    for (const ws of sockets.values()) if (ws.readyState === 1) ws.send(JSON.stringify(['REQ', 'me-0', { kinds: [0], authors: [me], limit: 1 }]));
    try {
      const r = await fetch(`${DIRECTORY}/api/profile/${me}`);
      const p = r.ok ? await r.json() : null;
      if (p && !profiles.has(me)) profiles.set(me, { content: { name: p.name, about: p.about, picture: p.picture, display_name: p.display_name }, created_at: 0 });
    } catch { /* directory down */ }
    await new Promise((r) => setTimeout(r, 800));
  }
  const cur = (profiles.get(me) || { content: {} }).content;
  $('#pf-name').value = cur.name || cur.display_name || '';
  $('#pf-about').value = cur.about || '';
  $('#pf-picture').value = cur.picture || '';
  dlg.showModal();
}
$('#pf-cancel').addEventListener('click', () => $('#profile').close());
$('#pf-save').addEventListener('click', async () => {
  const cur = (profiles.get(me) || { content: {} }).content;
  const next = { ...cur };
  const name = $('#pf-name').value.trim(), about = $('#pf-about').value.trim(), picture = $('#pf-picture').value.trim();
  if (!name) { sys('a profile needs at least a name'); return; }
  if (picture && !/^https?:\/\//.test(picture)) { sys('the picture must be an http(s) URL'); return; }
  next.name = name; if (cur.display_name) next.display_name = name;
  if (about) next.about = about; else delete next.about;
  if (picture) next.picture = picture; else delete next.picture;
  for (const k of Object.keys(next)) if (next[k] == null || next[k] === '') delete next[k];
  $('#pf-save').disabled = true;
  try {
    const { ev, ok, refused } = await publish(0, [], JSON.stringify(next));
    profiles.set(me, { content: next, created_at: ev.created_at });
    names.set(me, name); rerenderNames(me);
    $('#profile').close();
    sys(`profile published — accepted by ${ok.length} relay${ok.length === 1 ? '' : 's'}`
      + (refused.length ? `; refused by ${refused.map(([u, r]) => u.replace('wss://', '') + (r ? ' (' + r + ')' : '')).join(', ')}` : ''));
  } catch (err) { sys('could not publish the profile: ' + (err.message || err)); }
  $('#pf-save').disabled = false;
});

$('#compose').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ta = $('#text');
  const text = ta.value.trim();
  if (!text || !me) return;
  $('#send').disabled = true;
  try { await say(text); ta.value = ''; }
  catch (err) { sys('could not send: ' + (err.message || err)); }
  $('#send').disabled = false;
  ta.focus();
});
$('#text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#compose').requestSubmit(); }
});

// ---------------------------------------------------------------- sign-in
function renderWho() {
  const who = $('#who');
  who.textContent = '';
  if (!me) {
    const b = document.createElement('button'); b.textContent = 'Sign in'; b.addEventListener('click', openSignin);
    who.appendChild(b);
    $('#text').disabled = true; $('#send').disabled = true; $('#text').placeholder = 'Sign in to speak';
    return;
  }
  const s = document.createElement('span'); s.className = 'me'; s.dataset.pk = me; s.textContent = names.get(me) || short(me); s.title = me + ' — edit your profile';
  s.style.cursor = 'pointer'; s.addEventListener('click', openProfile);
  const pf = document.createElement('button'); pf.className = 'quiet'; pf.textContent = 'Profile'; pf.addEventListener('click', openProfile);
  const out = document.createElement('button'); out.className = 'quiet'; out.textContent = 'Sign out';
  out.addEventListener('click', () => { if (signer && signer.forget) signer.forget(); signer = null; me = null; renderWho(); sys('signed out — the key is forgotten in this browser'); });
  who.appendChild(s); who.appendChild(pf); who.appendChild(out);
  $('#text').disabled = false; $('#send').disabled = false; $('#text').placeholder = 'Say something to the fleet…';
  wantName(me);
}

function openSignin() {
  const dlg = $('#signin');
  $('#ext-row').hidden = !window.nostr;
  $('#key').value = '';
  dlg.showModal();
}
$('#cancel').addEventListener('click', () => $('#signin').close());
$('#use-ext').addEventListener('click', async () => {
  try {
    const pk = await window.nostr.getPublicKey();
    signer = { pubkey: pk, signEvent: (ev) => window.nostr.signEvent(ev) };
    me = pk; $('#signin').close(); renderWho(); sys('signed in with your extension');
  } catch (err) { sys('extension refused: ' + (err.message || err)); }
});
$('#use-key').addEventListener('click', async () => {
  const k = $('#key').value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(k)) { sys('that is not a 64-hex key'); return; }
  try {
    const { keySigner } = await import(KEYS_URL);
    signer = await keySigner({ key: k });
    me = signer.pubkey; $('#signin').close(); renderWho(); sys('signed in — the same key seals your gold in Tideholm');
  } catch (err) { sys('could not load the signer: ' + (err.message || err)); }
});

// A key already stored by Tideholm's den or tavern signs you in silently.
(async () => {
  try {
    if (localStorage.getItem('tidegate-nostr-key')) {
      const { keySigner } = await import(KEYS_URL);
      signer = await keySigner({ ask: async () => '' }).catch(() => null);
      if (signer) me = signer.pubkey;
    }
  } catch { /* no stored key */ }
  renderWho();
})();

// ---------------------------------------------------------------- boot
for (const url of RELAYS) connect(url);
status();
