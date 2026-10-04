# plinth

Self-hosted isometric **scene blocking** for pixel art. Compose a scene from primitives — blocks, slabs, walls, stairs, ramps, cylinders, spheres, cones, pyramids, arches — on a floor you size in tiles, stack them across levels, and export a pixel-exact greyscale template to paint over in Procreate.

Works with mouse + keyboard on desktop and with fingers + Pencil on iPad.

## Run it

```sh
# Docker (amd64 or arm64)
docker run -d -p 3000:3000 -v plinth-data:/data ghcr.io/therebelrobot/plinth:latest
# or: docker compose up -d   (see docker-compose.yml)
```

Open `http://<docker-host>:3000`. Scenes are stored in SQLite under `/data`.

```sh
# Development
npm install
npm run dev:server   # API on :3000 (tsx watch)
npm run dev          # Vite on :5173, proxies /api → :3000
npm test             # renderer, placement, PSD + zip validation (PSD check uses python psd-tools if installed)
npm run build && npm start
```

| Env | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |
| `DATA_DIR` | `./data` | SQLite lives here |
| `STATIC_DIR` | `./dist/public` | built client |

Releases: `npm run release:patch|minor|major` bumps the version and pushes the tag; `.github/workflows/release.yml` tests, then builds `linux/amd64,linux/arm64` to GHCR with signed provenance. Pin the actions to SHAs before relying on it (see the comment at the top of the workflow).

## The Procreate workflow

1. **Scene tab** — set tile width (px, multiple of 4; tile height is always half → 2:1 pixel iso), level height (½ tile = classic cube, ≈0.61 = true iso), floor tiles X × Y, level headroom, base thickness. The tab shows the resulting canvas size.
2. Block out the scene.
3. **Export tab → Layered PSD at 1×.** In Procreate: **Import** (or AirDrop / Files → Open in Procreate). Layers arrive separately: *Floor*, *Floor grid*, *Level 0…n*, *Outlines*.
4. Turn the template layers down, add your own layers on top and paint. For pixel work in Procreate, set the canvas's **resampling to Nearest Neighbour** and use a 1px hard brush.

Each level layer holds only the pixels that level *wins* after occlusion, so the layers never overlap. Hiding *Level 2* leaves a gap where it was rather than revealing hidden geometry behind it.

**Primitives in isolation:** Export tab → *Primitive in isolation* renders any shape at any size and facing, cropped to its bounds, at the scene's tile size. *Primitive kit (.zip)* holds every palette shape in every facing as separate PNGs, plus `sheet.png` and `kit.json` (cell positions and the ground-anchor offset for each sprite). *Object → Export alone* exports a placed piece by itself.

## Controls

### Tools
| | Desktop | iPad |
|---|---|---|
| Select / move | `V`, click, drag | tap, drag |
| Place | `B` or a shape key `1`–`0`, `-` | tap a shape |
| Erase | `E` | |
| Pan | `H`, hold `Space`, middle/right-drag, two-finger scroll | two-finger drag; one-finger drag on empty space in Select |
| Zoom | `⌘/Ctrl`+scroll, trackpad pinch, `F` to fit | pinch |
| Undo / redo | `⌘Z` / `⇧⌘Z` | toolbar |

### Placing
- **Stack** (default) — places on whatever you tap. Top face: on top (slabs stack at half levels). Side face: beside it at that height. Floor: on the floor.
- **Level** (`T`) — places on the **active level's** plane (blue outline) and ignores geometry. Use it to build an upper storey in mid-air, or to reach behind tall things. Change level with the ▲▼ control or `[` `]`.
- **Stamp** — dragging paints one piece per cell, on the plane where the drag started.
- **Stretch** (`S`) — dragging sizes a single piece to the rectangle. Walls and arches turn to follow the drag.
- **Facing** (`R`) — rotates the next piece. With Select active, `R` rotates the selection instead.
- **Cutaway** (eye button, `C`) — hides everything above the active level so you can work inside lower floors. Exports always include everything.

### Selected piece
Arrow keys move it on the floor (← → are −x/+x, ↑ ↓ are −y/+y), `⇧↑`/`⇧↓` move it up or down, `⌘D` duplicates, `Delete` removes. The Object tab has the same as touch buttons, plus exact position, size, facing, step count and wall thickness.

## Output modes (View tab)
- **Values**: *Light* (banded light from the upper left, 3–6 bands; a cube reads top > left > right), *Height* (value by level, good for multi-level readability), *Flat* (one value per piece), *Blank* (white, lines only).
- **Lines**: all edges, silhouettes only, or none. Lines are 1px and drawn on the nearer pixel, so they sit inside shapes the way pixel-art outlines do.
- **Merge flush faces** removes seams between touching pieces that share a plane, so a wall made of ten stamped blocks reads as one mass.
- Floor, floor grid, background (transparent / white / grey).

## How it works

The renderer is a per-pixel raycaster with a z-buffer (`src/core`). Each output pixel is one ray along the iso view direction `(1, 1, halfTile / levelHeight)`. Each primitive is intersected analytically in its own un-rotated frame, and the nearest hit wins. As a result:

- **Depth is always correct.** There's no painter's-algorithm sort, so overlapping and interpenetrating shapes, and stairs under arches, occlude correctly.
- **Edges are clean 2:1 staircases.** Rays sample exact pixel centres with no antialiasing, so a 32px tile has the classic 2-pixel diamond tips.
- **Outlines, value bands and layers come from the same buffers**, so editor and export always match.

World units are 1 tile in x/y and 1 level in z, so a 1×1×1 block is a geometric cube; level height in pixels only changes the projection.

Storage is one SQLite table (`node:sqlite`) of whole JSON scene documents. Scenes are always loaded and saved whole, so an ORM would add a dependency and a native engine without modelling anything. The server is `node:http` with no runtime dependencies. The client autosaves to the server and keeps a localStorage draft, so an unreachable server never loses work; the newer draft wins when the server comes back.

## Manual test checklist (real iPad)

Headless tests cover desktop mouse input, touch taps and drags, two-finger pinch (including "the first finger of a pinch must not leave a block behind"), the PSD (read back with psd-tools) and the zip. These need a real device:

- [ ] iPad Safari: pinch zooms the canvas, not the page; no double-tap zoom on buttons.
- [ ] Apple Pencil hover (M2+ iPads) shows the placement ghost before touching.
- [ ] Pencil tap/drag places and stamps. (A resting palm counts as a touch; a second contact cancels the stroke, but a palm that lands *first* will place — worth checking how that feels.)
- [ ] Export → share icon opens the share sheet with **Procreate** listed (needs HTTPS; over plain HTTP only download is offered).
- [ ] Layered PSD opens in Procreate with the named layers and transparent gaps.
- [ ] Add to Home Screen → launches full-screen; layout respects the notch/home-bar safe areas.
- [ ] iPad portrait: panel floats over the canvas, Fit centres the scene beside it, ✕ closes it.
- [ ] iPad + Magic Keyboard: shortcuts work, trackpad two-finger scroll pans, pinch zooms.
- [ ] Edit on iPad, reload on desktop → same scene, same objects.

## License

[Unlicense](LICENSE)
