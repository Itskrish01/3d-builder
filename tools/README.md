# tools

Not part of the build. Run with plain `node`.

### `check-engine.mjs` — keep this

A static check over `src/engine`: every name a module uses must be declared in
it, imported by it, or a browser global, and no module may assign to one of its
own imports. Both mistakes are silent at build time — Vite happily bundles a
module that references an undefined `World`, and you find out when someone
saves a scene.

```bash
node tools/check-engine.mjs
```

Worth running after any change that moves code between engine modules.

### `split-engine.mjs` and `analyze.mjs` — historical

The one-time migration from the previous build. That version was a single
10,900-line function in one HTML file, assembled from 29 text fragments, where
every symbol saw every other symbol because they shared one closure.

`analyze.mjs` parses those fragments and reports the symbol graph: what is
declared twice, what the engine calls that actually belongs to the UI, and what
resolves nowhere. `split-engine.mjs` uses it to write `src/engine/*.js` —
deciding which of the ~520 top-level symbols each module owns, emitting the
imports the code genuinely needs, deleting definitions that a later fragment
used to shadow, and rewriting every call into the old DOM UI onto the host
bridge.

They read from `legacy/src/*.txt` and **overwrite `src/engine/`**. Since that
directory has been edited by hand many times since, re-running them would throw
that work away. They are kept for provenance, not for use.
