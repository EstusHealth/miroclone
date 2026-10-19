# Live Board

A simple Miro-style whiteboard you share with a link. It deploys to Vercel as a
plain static site. There is no backend and no database.

- Open `/`, click **Create a board** to get a link like `/b/k7m2xq9pda`. Send it to anyone.
- Everyone with the link sees the same board live: sticky notes, text, rectangles,
  ellipses, freehand pen, and each other's cursors.
- Light and dark mode: follows your system setting, or use the sun/moon toggle (remembered per browser).
- Nothing is stored on any server. The board exists only in the browsers that have it open.
  When the last person closes the tab, it's gone. (A copy is kept in the tab's
  `sessionStorage` so a refresh doesn't wipe it when you're alone; closing the tab clears it.)

## How it works without a server

Vercel serves static files and short-lived functions, so it can't hold the live
WebSocket connections a normal realtime server needs. Instead the browsers connect
directly to each other:

1. **Finding each other:** each browser announces itself on a few public
   [Nostr](https://nostr.com) relays under a topic derived from the board id, using
   [Trystero](https://github.com/dmotz/trystero). Only encrypted WebRTC connection
   offers pass through the relays (the board id is the encryption password), never board content.
2. **Talking:** browsers then open direct, encrypted WebRTC data channels to each other
   and send edits, cursors and names peer to peer.
3. **Staying in sync:** each item carries a version number. The highest version wins, and
   deletes leave a small marker so an older copy can't bring an item back. When someone joins,
   every peer sends them its copy and they merge, so a late joiner (or someone whose
   connection dropped) catches up.

### Limits worth knowing

- **Group size:** every browser connects to every other, which works well up to roughly 10–20 people per board.
- **Strict networks:** some corporate or mobile networks block direct WebRTC connections.
  If people on such networks can't see each other, add a TURN server via `turnConfig` in
  `joinRoom` in `public/app.js` (for example Cloudflare's, which has a free tier). TURN only
  relays the encrypted traffic, and stores nothing.
- **Public relays:** joining depends on public Nostr relays. Trystero spreads across
  several at once, so one being down doesn't matter.
- **Link = access:** anyone with the link can join and edit.

## Deploy to Vercel

Import the repo in Vercel (no framework, no build step) or run `vercel` in the repo.
`vercel.json` serves `public/` and rewrites `/b/:id` to `index.html`.

## Run locally

```bash
npm run dev        # http://localhost:3000, no install needed
```

`npm install && npm run vendor` rebuilds `public/vendor/trystero.js`, the bundled
Trystero library. You only need it to upgrade Trystero.

## Controls

| Action | How |
| --- | --- |
| Tools | toolbar, or keys `V` select, `H` pan, `N` sticky, `T` text, `R` rectangle, `O` ellipse, `P` pen |
| Add a sticky fast | double-click empty canvas |
| Edit text | double-click an item, or select it and press `Enter` |
| Move / resize | drag an item / drag its corner handle |
| Multi-select | drag a box on empty canvas, or `Shift`+click |
| Pan | scroll, hold `Space` and drag, middle-drag, or one-finger drag on touch |
| Zoom | `Ctrl`/`⌘` + scroll (trackpad pinch), or the +/− buttons |
| Duplicate / delete | `Ctrl`/`⌘`+`D` / `Delete` |
