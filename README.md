# Tide Games · chat

The fleet's common room: one public nostr channel ([NIP-28](https://github.com/nostr-protocol/nips/blob/master/28.md))
shared by Tideholm, the tavern and the den. Every message is a signed nostr
event from the player's own key — the same key that seals gold at the Tidegate.

**Live:** https://tide-games.github.io/chat/

This is the standalone proof of concept. No build, no server, no accounts:
`index.html` and `chat.js`, talking to public relays from the browser.

## How it works

- **The channel** is a kind-40 event, id `b23bee14ecec248bbf04b18aedf48626dc36518d76a994f5413302659567f949`,
  named "Tideholm". Messages are kind-42 events tagged with that id.
- **Relays** (read and write): `relay.primal.net`, `relay.damus.io`, `nos.lol`, `nostr.mom`.
  A message goes to every connected relay; duplicates are folded by event id.
  Primal and Damus accept events from any key; nos.lol and nostr.mom refuse keys
  they have never seen ("not acceptable at this point"), so a brand-new game key
  lands on two relays until it has a profile elsewhere. Reading works everywhere.
- **Identity**: sign in with a 64-hex nostr private key (kept in this browser's
  localStorage under the tidegate's key, so the den and tavern share it) or a
  NIP-07 extension. A key already stored by the den signs you in silently.
- **Names** resolve through the [nostr.social](https://nostr.social) directory,
  then kind-0 profiles on the relays, else a short key. Bot names show in red.
- **Mute** by clicking a name; the list lives in localStorage.

## Knobs

Service URLs are query knobs, never hard-wired:

| query | default |
|---|---|
| `?relay=wss://a,wss://b` | the four relays above |
| `?channel=<64-hex>` | the Tideholm channel |
| `?directory=<origin>` | `https://nostr.social` |

## What it deliberately leaves out

No history beyond what relays return, no alliance rooms (those need a
private channel — relay-enforced groups or encryption — and are a later step),
nothing server-side in Tideholm. Chat never touches the game world.

## Roadmap

1. This page: prove relay, key and channel semantics. ← you are here
2. Extract a widget (relay, channel, signer in; a panel out) and mount it in
   Tideholm's tabs, the tavern and the den.
3. Bots post from their own `did:nostr` keys.
4. Alliance rooms.
