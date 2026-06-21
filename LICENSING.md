# SplatWalk Licensing

SplatWalk uses an **open-core** model, following the pattern proven at scale by
projects such as [MUI X](https://mui.com/x/): a permissively licensed core that
is free forever, with advanced capabilities reserved for a separately licensed
commercial tier.

## Package-to-license map

| Package | License | Use |
| --- | --- | --- |
| `@splatwalk/core` | MIT | The WASM binary, wasm-bindgen glue, hand-authored TypeScript types, and the framework-agnostic `floor` module. Free forever, including commercial and proprietary embedding. |
| `@splatwalk/core-pro` (reserved, not yet published) | Commercial | Advanced, opt-in capabilities (for example the streaming splat-storage adapter generator). Requires a paid license key at runtime. The core never depends on it. |

## Our commitment

Anything released under the MIT license stays MIT-licensed forever. The core is
not a time-limited or "open-for-now" grant: you can build a commercial product
on `@splatwalk/core` with no obligation to open-source your application, pay a
fee, or request permission.

The Pro tier exists so the project can fund full-time maintenance without gating
the core - revenue comes from advanced features that are hard for the community
to maintain, not from restricting who may embed SplatWalk. This is the same
trade MUI X makes with its MIT Community package and commercial Pro/Premium
packages.

## Why MIT for the core

The core runs client-side in the end user's browser or worker. A copyleft
network-use trigger (AGPL) is both weakly enforceable for client-side code and a
hard ship-gate for proprietary integrators - the opposite of broad adoption. MIT
removes that friction entirely while leaving the Pro tier as the monetization
seam. See [`docs/LICENSING-DECISION.md`](docs/LICENSING-DECISION.md) for the full
analysis behind this decision.

## Contributing

To keep the right to offer the future commercial Pro tier, the project must hold
a clear license to all contributions. Contributions are accepted under the
Developer Certificate of Origin (DCO); see [`CONTRIBUTING.md`](CONTRIBUTING.md).
