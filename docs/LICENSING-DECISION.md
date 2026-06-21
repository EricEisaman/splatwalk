# Licensing Decision

> **Resolved (v0.3.0).** The project adopted the **open-core model** proven at
> scale by MUI X: an **MIT-licensed core that is free forever** (published as
> `@splatwalk/core`) plus a reserved commercial tier (`@splatwalk/core-pro`) for
> advanced, opt-in capabilities. The repository `LICENSE` is now **MIT** (it was
> AGPL-3.0). See [`LICENSING.md`](../LICENSING.md) for the package-to-license map
> and the stewardship commitment, and [`CONTRIBUTING.md`](../CONTRIBUTING.md) for
> the DCO. The analysis below is retained as the rationale for that choice.
>
> **Not legal advice.** This document captures the original licensing analysis
> from the integrator feedback reflection (Sections 6 and 8). Obtain qualified
> legal counsel before adapting it.

## Guiding principle

Everyone deserves a free start. The core is MIT and free forever, so anyone -
hobbyist, startup, or enterprise - can get up and running, ship to production,
and embed SplatWalk in a commercial product without a fee, a license key, or a
permission slip. When a team needs the extra splat juice - the advanced, opt-in
capabilities of the Pro tier - they can buy into those paid features to support
the project's continued development. Free to start, pay only for the extras.

## Goal

A licensing posture where small players have unfettered, frictionless use, while
hyperscalers and large cloud providers who would resell SplatWalk as a service
must hold a paid agreement.

## Why the current AGPLv3 posture does not express that goal

- AGPL does not discriminate by company size or cloud-provider status; it
  discriminates by willingness to comply with copyleft. Under AGPL + a commercial
  dual-license, a small proprietary adopter faces the same friction as a
  hyperscaler. That is the opposite of "small players unfettered."
- Product-shape mismatch: AGPL's force is its network-use trigger, designed for
  server software users interact with remotely. SplatWalk's core runs client-side
  in the end user's browser/worker, where that trigger is weak and murky. AGPL is
  therefore arguably both mis-targeted and weakly enforceable for this product.

## The two axes to choose between

- **Behavior-based:** free for everyone except those who offer it as a hosted /
  managed service to third parties (or build a directly competing product). Keys
  on the exact behavior that harms the project; does not penalize a large studio
  that merely embeds SplatWalk in its own app; more battle-tested.
- **Size-based:** free below a company-size or revenue threshold, paid above it.
  Matches "small free, big pay" most literally, but taxes all large organizations
  rather than only cloud resellers, creates a hard cliff, and raises definitional
  questions (affiliates, revenue, headcount).

For a client-side library, the realistic threat is a provider wrapping the core
in a hosted conversion API — a behavior. A behavior-based license catches that
case without taxing large embedders.

## License candidates

- **Behavior-based:** Elastic License v2 (simplest "no hosting as a service"
  restriction); Business Source License 1.1 with an author-defined Additional Use
  Grant and a change date; Functional Source License (simplified BSL converting to
  Apache/MIT after two years); SSPL (strongest but heavy-handed and reputationally
  costly); or a Commons Clause rider on a permissive base.
- **Size-based:** PolyForm Small Business License (keyed to company size), with
  PolyForm Shield / Perimeter as the behavior-based members of the same suite.
- In every case, a commercial license is sold to whoever the source-available
  terms restrict; that is the paid tier.

> Note: every option except AGPL is **not** OSI-approved open source, which
> affects community perception, some corporate procurement, and foundation
> eligibility. AGPL is the only OSI-approved choice in this set.

## Architectural tweaks the license implies

- **Open-core split.** Put the thin integration layer (the TypeScript bridge, the
  type declarations, the wasm-bindgen glue, and examples) under a permissive
  MIT/Apache-2.0 license so integration carries zero friction for small players and
  large embedders alike, while the heavy Rust/WASM core stays under the
  source-available + commercial terms. This dovetails with the published
  distribution work (the project already separates the framework-agnostic floor
  module and hand-authored types from the binary core).
- **Single copyright + CLA or DCO.** Dual-licensing is only possible if the
  project owns or has been granted rights to all contributions. Consolidate
  copyright and require a contributor agreement before accepting outside changes,
  or the ability to sell commercial licenses is lost.
- **Trademark.** Even under permissive terms, a registered mark prevents anyone
  from shipping a SplatWalk-branded service. For a client-side library this is
  often the most practically enforceable lever.
- **Align the paid product with the architecture.** Because a license cannot be
  technically enforced on a binary shipped to the client, monetization is cleanest
  if the commercial offering is the project's own hosted conversion service, while
  the source-available license forbids others from re-hosting the core as a
  competing service.

## Decisions (Section 8)

- [x] **Licensing axis:** resolved as **open-core, MUI X model** - an MIT core
      that is free for everyone (including commercial embedding) with monetization
      reserved for a commercial Pro feature tier, rather than a behavior- or
      size-based restriction on the core.
- [x] **Open-core split:** adopted. The published `@splatwalk/core` (binary +
      glue + types + `floor` module) is MIT; the commercial `@splatwalk/core-pro`
      tier is reserved for advanced features and is not yet published.
- [x] **Contributor agreement:** adopted a **DCO** sign-off (see
      [`CONTRIBUTING.md`](../CONTRIBUTING.md)) so the project retains the right to
      offer contributions under the future commercial Pro tier.
- [ ] **Trademark:** register the SplatWalk mark (still open; the most practically
      enforceable lever for a client-side library).
- [ ] **Monetization shape:** the streaming splat-storage adapter generator (on
      the road to 1.0) is the planned first `@splatwalk/core-pro` feature; an
      official hosted conversion service remains an open option.
