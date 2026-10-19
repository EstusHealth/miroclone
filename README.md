# Live Board

A simple Miro-style whiteboard you share with a link. Nothing is stored.

- Open `/`, click **Create a board** to get a link like `/b/K_JcjPYW`. Send it to anyone.
- Everyone with the link sees the same board live: sticky notes, text, rectangles,
  ellipses, freehand pen, and each other's cursors.
- Board contents live only in the server's memory. When the last person leaves,
  the board is dropped after 30 seconds (long enough to survive a page refresh).
  The link keeps working and opens an empty board.

## Run it

```bash
npm install
npm start          # http://localhost:3000  (PORT env var to change)
```

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

## How it works

- `server.js`: a plain Node HTTP server for the static files in `public/`, plus a
  WebSocket endpoint (`/ws?room=<id>`) using `ws`. Each room is a `Map` of items in
  memory. Edits are last-write-wins per item and are relayed to everyone else in the room.
- `public/app.js`: the whole client, with no build step or framework.

## Deploying

It needs a host that runs a long-lived Node process with WebSockets, such as Render,
Railway, Fly.io or a small VPS. Serverless platforms like Vercel functions won't work,
because they can't hold WebSocket connections. Run a single instance: rooms live in that
process's memory, so several instances wouldn't see each other's boards.
