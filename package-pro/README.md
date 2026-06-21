# @splatwalk/core-pro (reserved - not yet published)

The commercial tier of SplatWalk, following the open-core model used by
[MUI X](https://mui.com/x/). The free [`@splatwalk/core`](../package/README.md) is
MIT and covers everyone's free start; `@splatwalk/core-pro` adds advanced, opt-in
capabilities for teams that need the extra splat juice, under a commercial license
with a runtime license key.

> Status: **scaffold only.** This package is reserved and not yet published. The
> directory holds the structure, license stub, and license-gate API so the first
> Pro feature can drop in cleanly.

## Planned features (road to 1.0)

- **Streaming splat-storage adapter generator** - generate ready-to-deploy
  streaming adapters for popular backend object stores (the first Pro feature,
  targeted for next month).
- **GPU-assisted shN palette clustering** - accelerate the slowest stage of SOG
  export on very large scenes.

The free core never depends on Pro: omitting `@splatwalk/core-pro` (or a license
key) leaves every `@splatwalk/core` feature fully functional.

## Intended usage

```ts
import { setLicenseKey } from '@splatwalk/core-pro';
import { generateStorageAdapter } from '@splatwalk/core-pro/streaming';

setLicenseKey(process.env.SPLATWALK_LICENSE_KEY!);

// Pro entry points verify the key before running.
const adapter = await generateStorageAdapter({ backend: 's3', /* ... */ });
```

## Licensing

Commercial. See [`COMMERCIAL-LICENSE.md`](COMMERCIAL-LICENSE.md) and the
project-wide [`LICENSING.md`](../LICENSING.md). A license key is required for
production use of Pro features.
