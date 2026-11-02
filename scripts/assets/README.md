# Habblaud Assets (AI Images + Pixel Art)

Habblaud brand, UI illustrations, and wall art. OpenRouter image models draw
the images, which Python post-processing turns into true pixel art: crisp grid,
limited palette, no dithering, binary alpha, and scaling exclusively with NEAREST. Characters and furniture
are **not** here: they are procedural (`client/src/art`).

```
scripts/assets/
  specs.json            recipe for each asset: model, aspect ratio, prompt, styles, and postprocessing parameters
  generate.mjs          calls OpenRouter (Node 24, no dependencies), with cache, retries, budget, and log
  postprocess.py        CLI: processes raw images and composites brand, icons, frames, og-image, and manifest
  pixelops.py           image operations (chroma key, grid detection, mode downsampling, palette...)
  pixelart.py           hand-drawn pixel art: 32/16 px mark, bitmap font, and "Habblaud" sign
  test_pixelops.py      tests (stdlib unittest)
  generation-log.json   all requests: model, exact prompt, file, cost, and selected takes
  .cache/               (ignored) raw/ = raw image in use, takes/ = all takes, contact-sheet.png
client/public/assets/   final output, served by Vite at /assets/ (manifest.json describes everything)
```

## Usage

Requirements: Node 24, exported `OPENROUTER_KEY` variable (only to generate), and Python 3 with Pillow and
numpy (on this machine's macOS, `/usr/bin/python3` already has both in user site-packages).

```sh
node scripts/assets/generate.mjs models            # models with image output
node scripts/assets/generate.mjs list              # assets and cache state
node scripts/assets/generate.mjs gen               # generates what is missing in .cache/raw/
node scripts/assets/generate.mjs gen poster-cat --force                          # new take
node scripts/assets/generate.mjs gen logo-mark --model openai/gpt-5.4-image-2 --as gpt   # alternative take
node scripts/assets/generate.mjs pick logo-mark gpt                              # adopts alternative take
python3 -E scripts/assets/postprocess.py           # generates client/public/assets/** + manifest + contact sheet
python3 -E scripts/assets/postprocess.py --only painting-cat --out /tmp/teste    # tests isolated asset
python3 -E scripts/assets/test_pixelops.py         # tests (grid/downscaling, chroma key, mode, font, marks)
```

- `gen` uses up to 2 retries per asset, runs with `--concurrency` (default 3), and refuses to exceed
  budget (`--budget`, default 45 requests in log). A lock (`.cache/generate.lock`) prevents
  two concurrent runs, because one would overwrite the other's log.
- Post-processing is deterministic: run it as many times as you want, at no cost.
- The key is only sent in the `Authorization` header: never printed, logged, or saved.
- `python3 -E` (not `-I`): `-I` disables user site-packages where Pillow and numpy live.
  `-E` still ignores `PYTHONPATH`. Scripts live in `scripts/assets/` and downloaded data
  in `.cache/` (different folder), so `sys.path` only contains our code.
- QA: open `scripts/assets/.cache/contact-sheet.png` (brand and wall art at 4x, illustration, and og-image).

## Art Direction (Original Prompts)

The prompts describe the style in generic terms, without citing games, tilesets, artists, or brands:
modern, bright, and cozy office, cool neutral grays, light porcelain tile, honey-colored wood,
blueish glass, lit blue monitors, blue sofas with orange cushions, terracotta planters, and colorful
folders, dark blue-gray outline (`#2b3245`), and lighting from top-left. The shared
`pixel` style (in `specs.json`) also asks for original art, without copying or imitating existing works.

Initial takes of the logo and illustration used an earlier version of this style referencing third-party
commercial works. They were discarded and removed from the log; the logo, hand-drawn marks derived from
it, icons, og-image, and illustration were remade with current prompts. Paintings and posters never used
that reference (their style is `wallart`/`poster`).

## Model Selection

List from 2026-10-06: 11 models with `image` in `output_modalities`. Compared three strong models with
the same prompt ("mountains" painting) and, for the logo, Flash and Pro with the same prompt, judging the
result **after** reduction to native size, which is what appears in the game:

| Model | Raw | Reduced | Time | Cost |
|---|---|---|---|---|
| `google/gemini-3.1-flash-image` | bold shapes; uneven pixels | **most readable at 26x16/12x16** | ~10 s | ~$0.07 |
| `google/gemini-3-pro-image` | rich pixel art, regular grid | best for native logo/scenes | ~25–35 s | ~$0.14 |
| `openai/gpt-5.4-image-2` | most detailed | too much detail: turns into noise | 75–120 s | higher |

Decision:
- **Gemini 3.1 Flash Image** (default): paintings and posters. Large, flat shapes survive
  26x16 and 12x16; it is fast and cheap, leaving budget to redo weak takes.
- **Gemini 3 Pro Image**: logo and empty office illustration. For the logo, Flash takes had
  off-grid "pixels" (downscaling left noise in windows); Pro comes out clean. In the
  illustration, it reproduces game elements: light porcelain tile, white desks with
  blue monitors, blue sofa with orange cushions, water cooler, terracotta, and colorful folders. This
  makes it coherent with the world.

## Post-Processing Pipeline

1. **Chroma key**: background color is median of image border (AI does not always hit
   `#FF00FF`), plus any clearly magenta shade (fringe). Small islands are removed.
2. **Native downscaling** (`kind: native`): AI draws on a grid of "large pixels" (~10 px per pixel
   in a 1024 image). A periodicity detector (comb over color edges on both axes,
   favoring smallest divisor of best period) finds the grid, and each block becomes a pixel (core mode).
   The result is native AI pixel art, lossless. This is how `logo-detailed.png` (78x86) is produced.
3. **Mode downsampling** (`art`, `poster`, `scene`): aspect ratio crop and reduction where each cell
   receives the most frequent color of an intermediate palette, without blending colors. This gives crisp
   edges, unlike averaging. `darkBias` favors dark tones (outlines) or, if negative,
   light tones (lit windows).
4. **Palette**: median cut + k-means, **without dithering**. The `balance` option resamples by 1/frequency^b,
   so small area colors (plant greens) do not disappear. With it, the scene fit in 32 colors.
   In the logo, `merge` merges nearly identical shades (RGB distance below threshold) that k-means sometimes
   creates within the same flat area; leaves one tone per material (24 colors).
5. **Finishing**: `despeckle` removes isolated pixels; 1px `#2b3245` outline on posters;
   3px frames (wood, black, white, gold) with top-left lighting on paintings.

### What Was Hand-Drawn (and Why)

- **32x32 mark and 16x16 favicon** (`pixelart.py`). Native AI art is 78x86 px, and scaling it down to 32
  or 16 always scrambles windows and bands. So the small mark is a "hinting" of the AI drawing:
  same building (slab with light trim, planter on right, wood slats, two blue screens on 2nd floor,
  glass door with awning), same sampled palette, redrawn pixel by pixel. The AI version appears where
  space permits (`logo-detailed.png`, `icon-512.png`, og-image).
- **Signage and og-image text**: scaled-down AI text is unreadable, and Pixelify Sans at pixel
  sizes closes the "C" opening ("Oode Town"). Hence a custom 5x7 proportional bitmap
  font, with lowercase, descenders, and Portuguese accents (á à â ã é ê í ó ô õ ú ç).

## Deliverables (`client/public/assets/`)

| File | Size | Note |
|---|---|---|
| `brand/logo-mark.png` / `@4x` | 32x32 / 128x128 | transparent, hand-drawn based on AI |
| `brand/logo-detailed.png` | 78x86 | native AI art (transparent) |
| `brand/favicon-16.png`, `favicon-32.png` | 16, 32 | transparent |
| `brand/apple-touch-icon.png`, `icon-192/512.png` | 180, 192, 512 | banded sky + sidewalk; 512 uses detailed building |
| `brand/signage.png` / `@4x` | 64x16 / 256x64 | reception signage |
| `illustrations/empty-office.png` | 960x540 | 480x270 native, x2 NEAREST, 32 colors |
| `art/painting-*.png` (8) | 26x16 | canvas only (no frame), for `rects.art` of `painting` sprite |
| `art/painting-wide-*.png` (3) | 58x24 | lounge |
| `art/framed/painting-*.png` | 32x22 and 64x30 | same art with 3px frame, occupying exactly 2 or 4 tiles |
| `art/poster-*.png` (6) | 12x16 | with outline; ids match `poster` furniture variants |
| `og-image.png` | 1200x630 | 600x315 native x2 |

### manifest.json

```jsonc
{
  "version": 1,
  "brand": {
    "mark": { "file": "brand/logo-mark.png", "w": 32, "h": 32 },
    "markLarge": { "file": "brand/logo-mark@4x.png", "w": 128, "h": 128 },
    "markDetailed": { "file": "brand/logo-detailed.png", "w": 78, "h": 86 },   // extra
    "signage": { "file": "brand/signage.png", "w": 64, "h": 16 },
    "signageLarge": { "file": "brand/signage@4x.png", "w": 256, "h": 64 },    // extra
    "favicon16": "brand/favicon-16.png", "favicon32": "brand/favicon-32.png",
    "appleTouch": "brand/apple-touch-icon.png", "icon192": "brand/icon-192.png", "icon512": "brand/icon-512.png"
  },
  "illustrations": { "emptyOffice": { "file": "illustrations/empty-office.png", "w": 960, "h": 540, "scale": 2 } },
  "wallArt": [
    {
      "id": "painting-mountains", "kind": "painting", "file": "art/painting-mountains.png", "w": 26, "h": 16,
      "tiles": 2, "title": "Montanhas ao amanhecer",
      "framed": { "file": "art/framed/painting-mountains.png", "w": 32, "h": 22 }
    },
    {
      "id": "poster-coffee", "kind": "poster", "variant": "coffee",
      "file": "art/poster-coffee.png", "w": 12, "h": 16, "tiles": 1, "title": "Café"
    }
  ],
  "og": "og-image.png"
}
```

Paths relative to `/assets/`. `w`/`h` are from the file. `tiles` is wall opening width in
tiles (poster 1, painting 2, wide painting 4), useful for choosing right art for each frame. In illustration,
`scale` indicates applied NEAREST scaling (native = w/scale). `variant` for posters is `poster` furniture variant
value in `client/src/art/api.ts` (`ship_it` included).

## Budget and Log

32 requests of 45 in the log (25 Flash, 6 Pro, 1 GPT 5.4), zero failures, ~$2.58 reported by
the API. The log does not include the 10 discarded takes for logo and illustration (see "Art Direction");
the numbers `n` were renumbered sequentially. Details in `generation-log.json`. `picks` records
adopted takes from comparisons (`logo-mark@v2e`, `empty-office@v2a`, `painting-mountains@gemini31flash`).
The entry for the Flash take of `painting-mountains` was reconstructed (no cost reported), because two
parallel executions overwrote the log; this is what motivated the lock. `specs.json` is the current recipe;
the log preserves the exact prompt of each take (paintings generated before the "full bleed" emphasis
in `wallart` style used the earlier version of that text, and takes `logo-mark@v2a` through `@v2c` used
earlier versions of the logo prompt).
