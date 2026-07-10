# Upstream collaboration notes

Working notes for **shared asks** we can bring to Babylon, PlayCanvas, Three.js,
and R3F maintainers. Goal: **unify** streamed Gaussian LOD behavior across
engines — same SOG / lod-meta contract, same budget semantics, same overlay
compositing expectations — not to pit communities against each other.

These are **not** filed tickets yet. When we file, lead with interop and
parity, cite each other’s good work, and offer repros + willingness to test PRs.

Local context: SplatWalk Storage Adapter (Babylon `GaussianSplattingStream`),
PlayCanvas church / city-scale catalogs, R3F Fast Nav (`@mkkellogg/gaussian-splats-3d`).

---

## Shared north star

| Principle | Why it unifies |
| --- | --- |
| **Budget ≠ catalog size** | One resident cap (e.g. ~4M Medium) works for 4M, 35M, or 200M+ cities |
| **Distance-aware LOD under budget** | Near detail + far/sky coverage without OOM — PlayCanvas balancer is the reference behavior |
| **One lod-meta / SOG contract** | Same CDN assets open in PlayCanvas, Babylon, and eventually Three/R3F |
| **Overlays on top of splats** | Navmesh / helpers / agents composite the same way in every viewer |
| **Documented orientation** | Z-up SOG → engine Y-up (or RHS) without each integrator rediscovering transforms |

PlayCanvas already ships much of this in [playcanvas/engine](https://github.com/playcanvas/engine)
([budget balancer](https://github.com/playcanvas/engine/pull/8444),
[geometric LOD](https://github.com/playcanvas/engine/pull/8506),
[interval compaction](https://github.com/playcanvas/engine/pull/8476)).
Babylon 9.16 brought streamed SOG into the web standard toolkit. Three/R3F are
where many product UIs live. **Closing the gaps is cross-pollination, not
competition.**

---

## 1. Babylon.js

**Repos:** https://github.com/BabylonJS/Babylon.js  
**Tone:** “Help Babylon match the PlayCanvas streaming contract so the same
lod-meta demos work in both engines.”

### 1.1 Distance-prioritized resident budget (shared with PC semantics)

**Gap:** Under `maxResidentSplats` / `memoryBudgetMb`, coarsest LODs are decoded
in set order and later files are skipped when full. PlayCanvas instead
**rebalances per-node LOD by camera distance** under a global splat budget.

**Collaborative ask:**

- Adopt (or closely mirror) PlayCanvas-style **global budget + distance-bucket
  degrade/upgrade** so sky/far nodes aren’t permanently starved.
- Credit / link PlayCanvas balancer design; offer church lod-meta as a **shared
  parity fixture** (same URL both engines).
- Public residency metrics (“decoded / resident / catalog”) for UI parity with
  PC demos.

### 1.2 Loader options for safe large catalogs

**Gap:** `AppendSceneAsync` / `SPLATFileLoader` don’t forward
`IGaussianSplattingStreamOptions`, so default full-catalog buffers OOM on
city-scale SOG.

**Collaborative ask:**

- Wire budget + LOD options through `pluginOptions` so Playground and docs can
  show the **same Medium defaults** PC demos use.
- Cross-link PlayCanvas streaming LOD docs from Babylon SOG samples.

### 1.3 Overlay compositing guidance

**Gap:** Translucent navmesh/helpers are easy to depth-occlude under Gaussians.

**Collaborative ask:**

- Document a **recommended overlay pattern** (render group / depth) that Three
  and PlayCanvas integrators can mirror.
- Optional helper so “debug walkable mesh on stream” is one line in all engines.

### 1.4 Readiness + orientation docs

**Collaborative ask:** Settled-stream API + Z-up SOG → Babylon Y-up notes,
aligned with PlayCanvas authoring conventions.

---

## 2. PlayCanvas

**Repos:** https://github.com/playcanvas/engine  
**Tone:** “You’re the reference implementation — help other engines speak the
same language.”

### 2.1 Interop / semantics doc (highest leverage for unity)

**Collaborative ask:**

- A short **“SOG streaming contract for other engines”** note covering:
  - geometric LOD (`lodBaseDistance` / `lodMultiplier`)
  - global `splatBudget` + balancer rules (far degrade / near upgrade)
  - interval work-buffer + sort model
  - budget independent of catalog size
- Explicit invitation for Babylon / Three / community ports to match these
  semantics for **asset and UX parity**.

### 2.2 Shared fixtures

**Collaborative ask:** Keep public demos (e.g. roman parish lod-meta) stable as
**cross-engine regression fixtures**; document Medium ≈ ~4M resident expectation
(including sky).

### 2.3 Optional reference algorithm

**Collaborative ask:** Publish balancer pseudocode / tests as a **neutral
reference** others can implement — not a demand to own other engines’ codebases.

---

## 3. Three.js

**Repos:** https://github.com/mrdoob/three.js  
**Tone:** “Bring streamed SOG into the Three ecosystem so R3F apps share the
same CDN assets as PC/Babylon.”

SplatWalk’s R3F path today uses `@mkkellogg/gaussian-splats-3d` for PLY/SPZ Fast
Nav — not yet CDN lod-meta streaming.

### 3.1 Blessed streamed LOD path (long-term, collaborative)

**Collaborative ask:**

- Interest in core support **or** an official example pointing at a maintained
  community package that implements the **PlayCanvas SOG + budget contract**.
- Avoid fragmenting into incompatible “Three-only” formats when lod-meta already
  exists.

### 3.2 Overlay depth with external splat viewers

**Collaborative ask:** Shared guidance for helpers/navmeshes over Gaussian
passes — same story Babylon/PC should document.

---

## 4. React Three Fiber / drei

**Repos:** https://github.com/pmndrs/react-three-fiber  
**Tone:** “Meet product UIs where they are — same streams, same budget UX.”

### 4.1 Streamed SOG example

**Collaborative ask:**

- Example (or drei pointer) for **budgeted streamed Gaussians** using the same
  lod-meta URLs as PlayCanvas/Babylon demos.
- Pattern: live stream + navmesh/agent overlays in one Canvas (events + order).

### 4.2 External viewer integration

**Collaborative ask:** Docs for attaching community splat viewers while keeping
R3F picking/controls predictable — bridges mkkellogg ↔ R3F ↔ future Three LOD.

---

## 5. Community bridge: `@mkkellogg/gaussian-splats-3d`

Natural partner for Three/R3F until/alongside core support.

**Collaborative ask:** Resident budget + SOG lod-meta streaming aimed at **parity
with PlayCanvas/Babylon**, not a third incompatible streaming dialect.

---

## How we talk to upstream (unity checklist)

- Open with **thanks** and a link to the other engine’s relevant PR/docs.
- Ask for **parity with a named contract**, not “be more like X / less like Y.”
- Offer: shared repro URL, SplatWalk test page, willingness to review/test.
- Prefer **docs + options + metrics** that all ecosystems can copy.
- File **parallel** issues (Babylon + PC doc + Three/R3F) that **cross-link**,
  so maintainers see one interop effort.

---

## Suggested sequence (build bridges, don’t silo)

1. **PlayCanvas interop doc** — gives everyone a shared vocabulary.
2. **Babylon loader budgets + balancer** — same demos, same Medium UX.
3. **Overlay compositing notes** in Babylon *and* Three (same recipe).
4. **R3F example + mkkellogg/Three streaming** — product UI on the same assets.

---

## Local bridges (SplatWalk)

Until upstream converges, SplatWalk will:

- Use budgeted `GaussianSplattingStream` construction (safe for large catalogs).
- Expose PlayCanvas-like quality presets and stream settings.
- Instrument decode/skip stats to feed concrete upstream repros.
- Fix overlay depth locally while documenting the pattern for all engines.
- Keep [`UPSTREAM_ISSUES.md`](UPSTREAM_ISSUES.md) focused on **shared contract**,
  not scorekeeping.

---

## Issue blurb (copy-paste, unity-first)

```markdown
### Summary
Cross-engine parity for streamed SOG (lod-meta): resident budget independent of
catalog size, distance-aware LOD under that budget (PlayCanvas balancer
semantics), and documented overlay compositing.

### Why
The same CDN assets and Medium (~4M resident) UX should work in PlayCanvas,
Babylon, and Three/R3F so creators aren’t locked to one runtime.

### Repro / fixture
https://code.playcanvas.com/examples_data/example_roman_parish_02/lod-meta.json

### References
- PlayCanvas: splatBudget + GSplatBudgetBalancer (engine PRs #8444, #8506, #8476)
- Babylon: GaussianSplattingStream / IGaussianSplattingStreamOptions

### Ask
…
### Offer
Repro app, testing on PRs, docs cross-links.
```
