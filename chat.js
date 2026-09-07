// Tide Games chat — the standalone page. It is the first HOST of the widget
// (widget.js): everything about the room lives there; this file only decides
// who is speaking (a pasted key, a NIP-07 extension, or a key the den already
// stored) and owns the two dialogs.
//
// Knobs (query string wins, so a season or a test can point elsewhere):
//   ?relay=wss://a,wss://b   relays to read from and write to
//   ?channel=<64-hex>        the kind-40 channel event id
//   ?directory=<origin>      where names are looked up (nostr.social by default)

import { mountChat } from './widget.js';

const q = new URLSearchParams(location.search);
const RELAYS = (q.get('relay') || 'wss://relay.primal.net,wss://relay.damus.io,wss://nos.lol,wss://nostr.mom')
  .split(',').map((s) => s.trim()).filter(Boolean);
const CHANNEL = (q.get('channel') || 'b23bee14ecec248bbf04b18aedf48626dc36518d76a994f5413302659567f949').toLowerCase();
const DIRECTORY = (q.get('directory') || 'https://nostr.social').replace(/\/+$/, '');
const KEYS_URL = 'https://melvincarvalho.github.io/tidegate/keys.js';

const $ = (s) => document.querySelector(s);
const short = (pk) => pk.slice(0, 8) + '…' + pk.slice(-4);

const chat = mountChat($('#room'), {
  relays: RELAYS, channel: CHANNEL, directory: DIRECTORY, height: '100%',
  readOnlyHint: 'Sign in to speak',
});

// ---------------------------------------------------------------- the channel's name (kind 40)
{
  const ws = new WebSocket(RELAYS[0]);
  ws.onopen = () => ws.send(JSON.stringify(['REQ', 'chan', { ids: [CHANNEL], kinds: [40] }]));
  ws.onmessage = (m) => {
    try {
      const msg = JSON.parse(m.data);
      if (msg[0] === 'EVENT') { const meta = JSON.parse(msg[2].content); $('#chan-name').textContent = meta.name || short(CHANNEL); ws.close(); }
      if (msg[0] === 'EOSE') ws.close();
    } catch { /* ignore */ }
  };
  ws.onerror = () => { $('#chan-name').textContent = short(CHANNEL); };
}

// ---------------------------------------------------------------- who speaks
let signer = null, me = null;

function renderWho() {
  const who = $('#who');
  who.textContent = '';
  if (!me) {
    const b = document.createElement('button'); b.textContent = 'Sign in'; b.addEventListener('click', openSignin);
    who.appendChild(b);
    return;
  }
  const s = document.createElement('a'); s.className = 'me'; s.dataset.pk = me; s.textContent = chat.names.get(me) || short(me); s.title = me;
  s.href = `${DIRECTORY}/${me}`; s.target = '_blank'; s.rel = 'noopener noreferrer'; s.style.textDecoration = 'none';
  const pf = document.createElement('button'); pf.className = 'quiet'; pf.textContent = 'Profile'; pf.addEventListener('click', openProfile);
  const out = document.createElement('button'); out.className = 'quiet'; out.textContent = 'Sign out';
  out.addEventListener('click', () => { if (signer && signer.forget) signer.forget(); use(null); });
  who.appendChild(s); who.appendChild(pf); who.appendChild(out);
  // the widget resolves the name; mirror it into the header when it lands
  const tick = setInterval(() => { const n = chat.names.get(me); if (n) { s.textContent = n; clearInterval(tick); } }, 500);
  setTimeout(() => clearInterval(tick), 15000);
}

function use(s) { signer = s; me = s ? s.pubkey : null; chat.setSigner(s); renderWho(); }

function openSignin() {
  $('#ext-row').hidden = !window.nostr;
  $('#key').value = '';
  $('#signin').showModal();
}
$('#cancel').addEventListener('click', () => $('#signin').close());
$('#use-ext').addEventListener('click', async () => {
  try {
    const pk = await window.nostr.getPublicKey();
    use({ pubkey: pk, signEvent: (ev) => window.nostr.signEvent(ev) });
    $('#signin').close();
  } catch (err) { alert('extension refused: ' + (err.message || err)); }
});
$('#use-key').addEventListener('click', async () => {
  const k = $('#key').value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(k)) { alert('that is not a 64-hex key'); return; }
  try {
    const { keySigner } = await import(KEYS_URL);
    use(await keySigner({ key: k }));
    $('#signin').close();
  } catch (err) { alert('could not load the signer: ' + (err.message || err)); }
});

// ---------------------------------------------------------------- profile (kind 0)
// Loaded FIRST so a real nostr identity is edited, never wiped.
let pfSeed = null;
async function openProfile() {
  if (!me) return;
  if (!chat.currentProfile()) {
    chat.requestProfile();
    try {
      const r = await fetch(`${DIRECTORY}/api/profile/${me}`);
      const p = r.ok ? await r.json() : null;
      if (p) pfSeed = { name: p.name, about: p.about, picture: p.picture, display_name: p.display_name };
    } catch { /* directory down */ }
    await new Promise((r) => setTimeout(r, 800));
  }
  const cur = chat.currentProfile() || pfSeed || {};
  $('#pf-name').value = cur.name || cur.display_name || '';
  $('#pf-about').value = cur.about || '';
  $('#pf-picture').value = cur.picture || '';
  $('#profile').showModal();
}
$('#pf-cancel').addEventListener('click', () => $('#profile').close());
$('#pf-save').addEventListener('click', async () => {
  const cur = chat.currentProfile() || pfSeed || {};
  const next = { ...cur };
  const name = $('#pf-name').value.trim(), about = $('#pf-about').value.trim(), picture = $('#pf-picture').value.trim();
  if (!name) { alert('a profile needs at least a name'); return; }
  if (picture && !/^https?:\/\//.test(picture)) { alert('the picture must be an http(s) URL'); return; }
  next.name = name; if (cur.display_name) next.display_name = name;
  if (about) next.about = about; else delete next.about;
  if (picture) next.picture = picture; else delete next.picture;
  for (const k of Object.keys(next)) if (next[k] == null || next[k] === '') delete next[k];
  $('#pf-save').disabled = true;
  try {
    const { ok, refused } = await chat.publishProfile(next);
    chat.names.set(me, name);
    $('#profile').close(); renderWho();
    if (!ok.length) alert('no relay accepted the profile: ' + refused.map(([u, r]) => u + ' ' + r).join('; '));
  } catch (err) { alert('could not publish the profile: ' + (err.message || err)); }
  $('#pf-save').disabled = false;
});

// A key already stored by the den or tavern (same origin) signs you in silently.
(async () => {
  try {
    if (localStorage.getItem('tidegate-nostr-key')) {
      const { keySigner } = await import(KEYS_URL);
      const s = await keySigner({ ask: async () => '' }).catch(() => null);
      if (s) { use(s); return; }
    }
  } catch { /* no stored key */ }
  renderWho();
})();
