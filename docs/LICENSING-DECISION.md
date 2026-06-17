# Licensing Decision (Owner TODO)

> **Not legal advice.** This document captures the licensing analysis from the
> integrator feedback reflection (Sections 6 and 8) as an open decision for the
> project owner. Obtain qualified legal counsel before adopting any option here.
> No license change has been made: the repository remains under **AGPL-3.0** (see
> [`LICENSE`](../LICENSE)).

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

## Open decisions for the owner (Section 8)

- [ ] **Licensing axis:** behavior-based (resell-as-a-service) vs. size-based
      (company threshold).
- [ ] **Open-core split:** adopt a permissive integration layer + source-available
      core, or keep a single license?
- [ ] **Contributor agreement:** adopt a CLA or DCO and consolidate copyright?
- [ ] **Trademark:** register the SplatWalk mark?
- [ ] **Monetization shape:** stand up an official hosted conversion service as the
      commercial offering?

Once the owner decides, follow up with the concrete `LICENSE` change (and, for an
open-core split, a permissive license file scoped to the integration layer) plus
`CONTRIBUTING` / CLA-or-DCO scaffolding.
