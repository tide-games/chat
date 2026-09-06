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
// and nostr.mom answer "not acceptable at this point" to keys they have never
// seen — they still serve as readers, and warm up once a key has a profile.
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
function onProfile(ev) {
  try {
    const p = JSON.parse(ev.content);
    const n = p.display_name || p.name;
    if (n && (!names.has(ev.pubkey) || names.get(ev.pubkey) === short(ev.pubkey))) { names.set(ev.pubkey, n); rerenderNames(ev.pubkey); }
  } catch { /* ignore */ }
}
function rerenderNames(pk) {
  document.querySelectorAll(`.n[data-pk="${pk}"]`).forEach((el) => { el.textContent = names.get(pk); el.classList.toggle('bot', KNOWN_BOTS.test(names.get(pk))); });
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
function applyMutes() {
  const m = muted();
  document.querySelectorAll('.msg').forEach((el) => el.classList.toggle('muted', m.has(el.dataset.pk)));
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
    n.title = ev.pubkey + ' — click to mute/unmute';
    n.addEventListener('click', () => toggleMute(ev.pubkey));
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

async function say(text) {
  const ev = {
    pubkey: me,
    created_at: Math.floor(Date.now() / 1000),
    kind: 42,
    tags: [['e', CHANNEL, RELAYS[0], 'root']],
    content: text,
  };
  const ser = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
  const bytes = new TextEncoder().encode(ser);
  ev.id = hex(await sha256(bytes));
  if (signer.signEvent) {
    const signed = await signer.signEvent(ev);     // NIP-07: the extension signs
    ev.sig = signed.sig; ev.id = signed.id;
  } else {
    ev.sig = await signer.sign(bytes);             // tidegate: schnorr(sha256(bytes)) = schnorr(id)
  }
  let sent = 0;
  for (const ws of sockets.values()) if (ws.readyState === 1) { ws.send(JSON.stringify(['EVENT', ev])); sent++; }
  if (!sent) throw new Error('no relay is connected');
  onEvent(ev, 'self'); // show at once; relays will echo the same id and be deduped
}

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
  const s = document.createElement('span'); s.className = 'me'; s.dataset.pk = me; s.textContent = names.get(me) || short(me); s.title = me;
  const out = document.createElement('button'); out.className = 'quiet'; out.textContent = 'Sign out';
  out.addEventListener('click', () => { if (signer && signer.forget) signer.forget(); signer = null; me = null; renderWho(); sys('signed out — the key is forgotten in this browser'); });
  who.appendChild(s); who.appendChild(out);
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
