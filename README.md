# Grass Painter

A browser world builder for people who have never opened a 3D tool. Shape the
ground, plant grass on it, put things on top.

React + Vite for the chrome, a hand-written WebGL engine on top of three.js for
the world.

```bash
npm install
npm run dev        # http://localhost:5175
npm run build      # -> dist/
npm run preview    # serve the built output
npm run lint
```

Needs WebGL. There is a graceful fallback screen if it is missing.

## Four stations

The left rail has four stations and nothing else. Keys `1`–`4`.

| | |
|---|---|
| **Terrain** | Drag on the ground to push it up. Alt digs down. Raise, Lower, Smooth, Flat — plus Ramp, Roughen and Erode behind *All settings*. Seven named landforms as chips. |
| **Grass** | Drag to plant, Alt to rub out. Six named looks, blade height, two colours, a wind dial. |
| **Place** | Everything you add, from one library: houses, trees, props, people, vehicles, saved groups. Place one, Scatter, Remove. Click the chosen model again — or press <kbd>Esc</kbd> — to put the brush down. |
| **Select** | Click to pick, Shift-click to add, drag to lasso. Move, turn, resize, duplicate, delete. |

Every station glyph is drawn in the same frame with the same ground line, so
the rail reads as four strata of one continuous piece of earth.

Anything belonging to the **world** rather than to a station — time of day,
haze, ground colour, water, quality, the camera, layers, autosave — lives
behind the sun button in the top bar.

A first run opens on a **blank grid baseplate** — flat grey ground, a 4 m grid
to judge distance by, and nothing else. Everything in the world is then
something the person put there. The six finished scenes (village, mountain
town, city block, island, farm, empty plain) are one click away under **New
world**.

An eight-step guided tour starts alongside it. The scrim is the spotlight's own
box-shadow and only the card takes pointer events, so each step can be tried
for real while it is on screen; the fly, sculpt and paint steps watch for you
doing it and move on by themselves. `?` brings it back.

## Explorer and Properties

The right panel has two tabs. **Settings** is the station you are in.
**Explorer** is the other view of the same scene: a tree of named folders over
everything placed, with a Properties block under it.

- Folders are organisational only — nothing in the renderer knows they exist,
  so no arrangement here can break a scene. They nest, they refuse to be moved
  inside themselves, and deleting one lifts its contents to the parent rather
  than destroying them (it asks first if you want them gone too).
- There is **one** selection. Clicking a row selects in the world; selecting in
  the world highlights the row and expands whatever folder it was hiding in.
  Shift-click adds.
- **Properties** shows what the thing is and every number that describes it —
  position, turn, size, how much it leans with the ground — editable, and
  working on a multi-selection as one.

Folders travel in the scene file, and a dangling folder reference is repaired
to the root on load.

## Where the Sketchfab token comes from

Everything placeable is a Sketchfab model. **The app never asks for a token** —
credentials are the job of whoever set it up, not of the person trying to place
a tree. It reads one from the environment, in one of two arrangements.
Searching works with no token at all; only downloading needs one.

```bash
cp .env.example .env
```

**On your own machine** — one line, and the browser talks to Sketchfab directly:

```ini
VITE_SKETCHFAB_TOKEN=your-token
```

⚠️ Vite inlines every `VITE_*` variable into the JavaScript it ships, so this
token **is readable by anyone who opens a deployed build**. Fine locally, or
for a deploy only you can reach. Not a secret.

**For a public deploy** — leave the above blank and let the server hold it.
`api/sketchfab.js` forwards the two endpoints that need auth, so the token
never reaches the browser:

```ini
SKETCHFAB_TOKEN=your-token
VITE_SKETCHFAB_PROXY=1
```

`npm run dev` proxies `/api/sketchfab` and adds `SKETCHFAB_TOKEN` if it is set,
so dev and production speak the same protocol.

> `.env` is read when the dev server starts and baked in at build time.
> After changing it, restart `npm run dev` and reload the page.

If neither is configured the import dialog says so up front, rather than
letting you search and then failing with an unexplained 401.

## Deploying

Static output plus one optional function. Both hosts are configured already.

**Vercel** — `vercel.json` is in the repo. Push, import, done. For a public
deploy set `SKETCHFAB_TOKEN` (secret) and `VITE_SKETCHFAB_PROXY=1` in the
project's environment variables.

**Netlify** — `netlify.toml` is in the repo, with `api/` as the functions
directory and the same `/api/sketchfab/*` redirect.

**Anywhere static** (GitHub Pages, S3, nginx) — `npm run build` and serve
`dist/`. There is no proxy, so set `VITE_SKETCHFAB_TOKEN` before building and
keep in mind it ships to the client.

The build splits three.js and React into their own chunks, so a change to the
UI does not make everyone re-download the renderer:

| chunk | size | gzip |
|---|---|---|
| three | 457 kB | 117 kB |
| app | 273 kB | 95 kB |
| react | 142 kB | 45 kB |
| css | 27 kB | 6 kB |

## How it is put together

```
src/
  engine/     28 ES modules. WebGL, terrain, grass, roads, actors, save/load.
              Imperative, owns one canvas, knows nothing about React.
  ui/         React. Owns every pixel of DOM, reads engine state directly.
  styles/     Design tokens, then chrome / controls / overlays.
api/          Optional serverless Sketchfab proxy.
tools/        One-time migration scripts + a static checker. Not in the build.
legacy/       The previous single-file build, kept for reference.
```

**The engine is not React state.** It is created once and handed down through
context; panels read `engine.state` directly. Mirroring two hundred settings
into React would mean two copies of the truth and a sync bug for each one.

**The two talk through `engine/host.js`, and only there.**

- `emit(topic)` — the engine says *something changed*; it never knows who is
  listening. `useEngineTopic('mode', 'scene')` subscribes and coalesces several
  announcements in a frame into one render.
- `ui.*` — the handful of things the engine genuinely needs a person for: a
  message, a confirmation, the file picker. Every one has a no-op default, so
  the engine runs headless with no UI attached.

Nine imperative "go and repaint that part of the page" calls in the old build
collapsed into that one `emit`.

**Controls are one vocabulary.** Each binds to a state path (`path="grass.height"`)
or to an explicit get/set pair, so the same `<Slider>` serves a world setting
and a per-model setting. `apply={['grass']}` names the work a change needs —
a uniform upload, a geometry rebuild — and `engine/apply.js` decides what runs.

### The migration

The previous version was one 10,900-line closure in a single HTML file, where
every symbol saw every other symbol. `tools/split-engine.mjs` parsed it, worked
out which of the ~520 top-level symbols each of the 28 modules owns, and wrote
the imports the code actually needs — rather than a human guessing at 500
references and getting some of them wrong. It also rewrote every call into the
old DOM UI onto the host bridge.

`tools/check-engine.mjs` is the part worth keeping: it re-checks that every
name a module uses is declared, imported or a browser global, and that nothing
assigns to an imported binding. Both are silent at build time.

```bash
node tools/check-engine.mjs
```

## Animated models

A model that arrives with glTF clips can play them. Because everything is drawn
instanced — one draw call for every copy of a house — a skeleton per copy is
not on the table, so each clip is **sampled on the CPU at import and baked into
a texture**: one run of texels per frame, read back in the vertex shader. Fifty
walking people are still one draw call, and each gets a random phase so they
are not in lockstep.

The controls live with the model, under *All settings → Your models*: whether
it plays, which clip, and how fast. A still model shows none of this.

What that costs, and where it stops:

- Up to 4 clips, 6–24 frames each at 15 fps, interpolated in the shader.
- A budget of 800,000 texels per model (~6.4 MB as RGBA half-float). Clips are
  dropped from the end until it fits; a model too dense for even one clip stays
  still and the library says so rather than quietly eating VRAM.
- Normals are not re-baked, so lighting follows the rest pose. On the gentle
  motion this is for, the error is not visible.
- Thumbnails deliberately show the rest pose.

## Ray tracing

**Render** in the top bar path-traces the view you are looking at, via
[three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer): rays
are traced against a BVH in a fragment shader, one sample per frame,
accumulating until the noise settles. Light bounces, so shadows are cast by
whatever blocks them, surfaces pick up colour from what is next to them, and
glass and metal behave like glass and metal.

It is a **still**, not a mode you build in, and that is not a shortcut — a path
tracer needs hundreds of samples per pixel to converge. You build in the fast
view and then photograph it. Three lengths: Quick (64 samples), Good (400),
Patient (2000). Save at any point; it only gets cleaner. Clicking the world or
pressing a movement key puts you back in the fast view.

### The scene has to be baked first

Nothing in this engine is a `THREE.Mesh`. Every blade, house and metre of
ground is drawn by a custom shader that computes its vertices on the GPU from
instance attributes, a heightfield texture and noise. A BVH is built on the CPU
from real triangles, so a path tracer handed this scene sees one model at the
origin and an empty plane.

So `engine/pathtrace.js` bakes one: every placed object becomes a real mesh at
its own transform — the object already carries the quaternion and scale the
instance buffer uses, so the bake cannot drift out of step with what you were
looking at — and the terrain hands over the vertex buffer it already keeps on
the CPU. Slope and altitude colouring is baked to vertex colours so cliffs stay
rock and tops stay snow. The sky becomes an equirectangular gradient from the
same zenith and horizon colours the sky shader uses, so the render is lit by
your time of day rather than a studio preset.

**Grass is not traced.** The blades exist only on the graphics card and there
are far too many of them to hand a ray tracer. The ground keeps its colour;
everything placed, the landscape and the water are traced.

### Version notes

`three` is pinned to **0.151.0** — the oldest release satisfying
three-gpu-pathtracer's peer dependency, and two minors from where this project
started. Later three enables colour management by default, which would upload
base-colour maps as sRGB and double-decode against the manual decode in
`IMP_FS`, darkening every imported model.

The tracer is built against a newer three and wants four things that arrived
after 0.151: `Scene.backgroundRotation` / `environmentRotation` /
`environmentIntensity` (r163) and `WebGLRenderer.compileAsync` (r152). It reads
the scene fields from its own constructor, on a scene of its own, so there is
no object of ours to put them on. All four are defined in `pathtrace.js`; every
other renderer method it touches — twenty-three of them — already exists here.

Every shader here tone maps and gamma-encodes itself, so the renderer sits in
linear with no tone mapping. The tracer's final blit does the opposite. The
renderer's output stage is switched over for the duration of a render and put
back afterwards; our own materials are `ShaderMaterial`s, which three leaves
alone under either setting.

## Why an imported model used to change colour

A model looked one colour on Sketchfab and a darker, more saturated one here.
Two separate causes, both fixed.

**The tone curve was applied per channel.** Compressing R, G and B each by a
different amount does not darken a colour, it *changes* it — and by a different
amount depending on how much light was falling on it, so one leaf was several
colours. A leaf authored at `74,122,46` came out `40,88,20`: its red-to-green
ratio moved from 0.61 to 0.46, and drifted to 0.58 in full sun. The curve now
maps luminance and carries the chroma through, so the same leaf reads 0.61 in
shade and 0.60 in sun. Highlights still bleach toward white, because real ones
do.

**Nothing filled the shadows.** An outdoor sky lights the shaded side at about
a third of the sunlit side — physically right, and nothing like the even light
a model was photographed under wherever you found it. **Light on models** in
the World sheet adds back a near-uniform environment: high shows a model close
to the colours it had at the source, low lets the scene's own sun and shadow
fall across it. It only touches imported models, so the world's own look is
unchanged.

Import also used to discard four things that decide how a model shades, all of
which are now carried through: **unlit materials** (`KHR_materials_unlit`,
which already have their lighting painted into the texture and were being lit a
second time), **emissive** colour and maps, **vertex colours**, and the
**metallic-roughness map** — without which a model whose factors defaulted to
1.0 shades as solid metal, which is to say nearly black. Materials that differ
in any of these no longer merge into one another.

> Models already in your library keep the appearance they were imported with.
> Re-import to pick up the material work; the tone curve and the fill apply to
> everything immediately.

Still not read from a glTF: normal maps, occlusion maps, and clearcoat/sheen
extensions.

## Moving around

| | |
|---|---|
| `W` `A` `S` `D` | fly forward / left / back / right |
| `E` / `Q` | fly up / down |
| `Shift` | fly faster |
| Right-drag | look around |
| Right-drag + wheel | trim fly speed |
| Wheel | move forward / back |
| Middle-drag | pan |
| `Space` + left-drag | orbit |
| `F` | fly to the selection, or frame the world |

Field of view is in the World sheet under **Camera** — 20° for a flat
telephoto look, 110° for a wide angle that exaggerates distance.

`R` or `Alt`+wheel turns what you are placing, so the wheel is always the
camera. `?` lists everything.

## Design

Chrome is soil at dusk (`#16130E` → `#2C271D`), one accent `#FFB43D`. Green is
the material you paint, so an interface that is also green competes with the
work; gold never occurs in a midday field, so it always reads as interface.
Archivo with the width axis at 118 for things that *name* something, IBM Plex
Mono for every measured value. Both fall back to system stacks with no layout
shift.

Every text pair clears WCAG AA on its own background. Keyboard focus is
visible, the layout is responsive to a phone, and `prefers-reduced-motion`
turns the animation off.

## Notes and limits

- **Style is whatever you import.** Scene cohesion depends on picking models
  that go together.
- **Pedestrians and traffic follow paths and roads** with a subtle bob of their
  own, independent of any baked clip.
- **Import normalises only obviously wrong units.** Each library row has a
  **True size** slider for the rest.
- **Roads are template-only.** The engine is intact — templates lay them,
  buildings face them, Select deletes them — but there is no drawing tool.
- **A world saved by the previous version still opens.** The old stations are
  migrated (`build`/`nature`/`people` → Place, `roads` → Terrain).
- Autosave writes to IndexedDB every 30 s. **Save** writes a portable JSON.
