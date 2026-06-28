/**
 * Core secrets resolver implementation for GitHub, Render, and Netlify.
 */

import type {
  SecretReference,
  SecretsResolver,
  ResolvedSecret,
  SecretResolutionOptions,
  SecretsResolverConfig,
  SecretPlatformDetector,
} from './types';

/**
 * Default resolution options.
 */
const DEFAULT_OPTIONS: Required<SecretResolutionOptions> = {
  enableCache: true,
  cacheTtl: 5 * 60 * 1000, // 5 minutes
  timeout: 10_000,
  throwOnMissing: true,
};

/**
 * In-memory cache for resolved secrets.
 */
interface CacheEntry {
  value: ResolvedSecret;
  expiresAt: number;
}

/**
 * Detects available secret platforms in the current environment.
 */
function detectSecretPlatforms(): SecretPlatformDetector {
  // Check if we're in a Node.js environment
  const isNode = typeof process !== 'undefined' && process.versions?.node;

  const hasGitHub =
    isNode && process.env?.GITHUB_ACTIONS === 'true';
  const hasRender =
    isNode && process.env?.RENDER === 'true';
  const hasNetlify =
    isNode && process.env?.NETLIFY === 'true';

  const availablePlatforms: Array<'github' | 'render' | 'netlify'> = [];
  if (hasGitHub) availablePlatforms.push('github');
  if (hasRender) availablePlatforms.push('render');
  if (hasNetlify) availablePlatforms.push('netlify');

  return {
    hasGitHub,
    hasRender,
    hasNetlify,
    availablePlatforms,
  };
}

/**
 * Core secrets resolver implementation.
 */
export class DefaultSecretsResolver implements SecretsResolver {
  private cache = new Map<string, CacheEntry>();
  private config: Required<SecretsResolverConfig>;
  private platforms: SecretPlatformDetector;

  public constructor(config?: SecretsResolverConfig) {
    this.config = {
      githubToken: config?.githubToken || '',
      renderApiKey: config?.renderApiKey || '',
      netlifyToken: config?.netlifyToken || '',
      defaultCacheTtl: config?.defaultCacheTtl || DEFAULT_OPTIONS.cacheTtl,
      autoDetect: config?.autoDetect ?? true,
    };

    this.platforms = detectSecretPlatforms();
  }

  /**
   * Detect available platforms in current environment.
   */
  getAvailablePlatforms(): SecretPlatformDetector {
    return this.platforms;
  }

  /**
   * Resolve a secret reference.
   */
  async resolve(
    reference: SecretReference,
    options?: SecretResolutionOptions
  ): Promise<ResolvedSecret | undefined> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const cacheKey = this.getCacheKey(reference);

    // Check cache
    if (opts.enableCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.value;
      }
      this.cache.delete(cacheKey);
    }

    try {
      const resolved = await this.resolveImpl(reference, opts);

      if (!resolved && opts.throwOnMissing) {
        throw new Error(
          `Secret not found: ${this.formatReference(reference)}`
        );
      }

      // Cache the result
      if (resolved && opts.enableCache) {
        this.cache.set(cacheKey, {
          value: resolved,
          expiresAt: Date.now() + (resolved.ttl || opts.cacheTtl),
        });
      }

      return resolved;
    } catch (error) {
      if (opts.throwOnMissing) throw error;
      return undefined;
    }
  }

  /**
   * Resolve multiple secrets in parallel.
   */
  async resolveMultiple(
    references: SecretReference[],
    options?: SecretResolutionOptions
  ): Promise<(ResolvedSecret | undefined)[]> {
    return Promise.all(
      references.map((ref) => this.resolve(ref, options).catch(() => undefined))
    );
  }

  /**
   * Clear the cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Test if a secret reference is resolvable.
   */
  async canResolve(reference: SecretReference): Promise<boolean> {
    try {
      const result = await this.resolve(reference, {
        throwOnMissing: false,
        enableCache: false,
      });
      return result !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Actual resolution implementation by platform.
   */
  private async resolveImpl(
    reference: SecretReference,
    options: Required<SecretResolutionOptions>
  ): Promise<ResolvedSecret | undefined> {
    switch (reference.type) {
      case 'plain':
        return {
          value: reference.value,
          source: 'plain',
          resolvedAt: new Date(),
          ttl: 0, // Don't cache plain values
        };

      case 'github':
        return this.resolveGitHub(reference, options);

      case 'render':
        return this.resolveRender(reference, options);

      case 'netlify':
        return this.resolveNetlify(reference, options);

      default:
        throw new Error(
          `Unknown secret type: ${(reference as any).type}`
        );
    }
  }

  /**
   * Resolve GitHub Secrets.
   */
  private async resolveGitHub(
    ref: Extract<SecretReference, { type: 'github' }>,
    options: Required<SecretResolutionOptions>
  ): Promise<ResolvedSecret | undefined> {
    // In GitHub Actions, secrets are available as environment variables
    // They are automatically injected by the Actions runtime
    if (typeof process !== 'undefined' && process.env) {
      const value = process.env[ref.key];
      if (value) {
        return {
          value,
          source: `github:${ref.key}`,
          resolvedAt: new Date(),
        };
      }
    }

    // If not in Actions, try GitHub API (requires token)
    if (ref.token || this.config.githubToken) {
      const token = ref.token || this.config.githubToken;
      // Note: This would require authenticated API calls to GitHub
      // which is beyond the scope of client-side resolution.
      // Typically handled server-side in CI/CD contexts.
      return undefined;
    }

    return undefined;
  }

  /**
   * Resolve Render.com environment variables.
   */
  private async resolveRender(
    ref: Extract<SecretReference, { type: 'render' }>,
    options: Required<SecretResolutionOptions>
  ): Promise<ResolvedSecret | undefined> {
    // In Render.com environment, vars are available as process.env
    if (typeof process !== 'undefined' && process.env) {
      const value = process.env[ref.key];
      if (value) {
        return {
          value,
          source: `render:${ref.key}`,
          resolvedAt: new Date(),
        };
      }
    }

    // If not in Render environment, try API (requires API key)
    if (ref.apiKey || this.config.renderApiKey) {
      return this.resolveRenderAPI(ref, options);
    }

    return undefined;
  }

  /**
   * Resolve from Render.com API.
   */
  private async resolveRenderAPI(
    ref: Extract<SecretReference, { type: 'render' }>,
    options: Required<SecretResolutionOptions>
  ): Promise<ResolvedSecret | undefined> {
    const apiKey = ref.apiKey || this.config.renderApiKey;
    if (!apiKey) return undefined;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeout);

    try {
      // Render.com API endpoint for retrieving environment variables
      // https://render.com/docs/api-reference
      const url = new URL('https://api.render.com/v1/services');
      if (ref.serviceId) {
        url.pathname += `/${ref.serviceId}/env-vars`;
      }

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        return undefined;
      }

      const data = (await response.json()) as any;
      
      // Find the env var by key
      const envVar = data.find?.((v: any) => v.key === ref.key);
      if (envVar?.value) {
        return {
          value: envVar.value,
          source: `render-api:${ref.key}`,
          resolvedAt: new Date(),
        };
      }

      return undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Resolve Netlify environment variables.
   */
  private async resolveNetlify(
    ref: Extract<SecretReference, { type: 'netlify' }>,
    options: Required<SecretResolutionOptions>
  ): Promise<ResolvedSecret | undefined> {
    // In Netlify build context, vars are available as process.env
    if (typeof process !== 'undefined' && process.env) {
      const value = process.env[ref.key];
      if (value) {
        return {
          value,
          source: `netlify:${ref.key}`,
          resolvedAt: new Date(),
        };
      }
    }

    // If not in Netlify build, try API (requires token)
    if (ref.token || this.config.netlifyToken) {
      return this.resolveNetlifyAPI(ref, options);
    }

    return undefined;
  }

  /**
   * Resolve from Netlify API.
   */
  private async resolveNetlifyAPI(
    ref: Extract<SecretReference, { type: 'netlify' }>,
    options: Required<SecretResolutionOptions>
  ): Promise<ResolvedSecret | undefined> {
    const token = ref.token || this.config.netlifyToken;
    if (!token || !ref.siteId) return undefined;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeout);

    try {
      // Netlify API endpoint for retrieving environment variables
      // https://docs.netlify.com/api/get-started/#authentication
      const url = `https://api.netlify.com/api/v1/sites/${ref.siteId}/env`;

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        return undefined;
      }

      const data = (await response.json()) as any;
      
      // Netlify returns env vars in the format { key: { value: "..." } }
      const envValue = data[ref.key];
      if (envValue?.value) {
        return {
          value: envValue.value,
          source: `netlify-api:${ref.key}`,
          resolvedAt: new Date(),
        };
      }

      return undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Generate a cache key for a secret reference.
   */
  private getCacheKey(ref: SecretReference): string {
    switch (ref.type) {
      case 'plain':
        return `plain:${ref.value}`;
      case 'github':
        return `github:${ref.key}`;
      case 'render':
        return `render:${ref.key}:${ref.serviceId || ''}`;
      case 'netlify':
        return `netlify:${ref.key}:${ref.siteId || ''}`;
      default:
        return 'unknown';
    }
  }

  /**
   * Format a secret reference for display (without exposing the value).
   */
  private formatReference(ref: SecretReference): string {
    switch (ref.type) {
      case 'plain':
        return 'plain:<hidden>';
      case 'github':
        return `github:${ref.key}`;
      case 'render':
        return `render:${ref.key}`;
      case 'netlify':
        return `netlify:${ref.key}`;
      default:
        return 'unknown';
    }
  }
}

/**
 * Create a secrets resolver with default configuration.
 */
export function createSecretsResolver(
  config?: SecretsResolverConfig
): SecretsResolver {
  return new DefaultSecretsResolver(config);
}

/**
 * Global singleton instance of the secrets resolver.
 */
let globalResolver: SecretsResolver | null = null;

/**
 * Get the global secrets resolver instance.
 */
export function getGlobalSecretsResolver(): SecretsResolver {
  if (!globalResolver) {
    globalResolver = new DefaultSecretsResolver();
  }
  return globalResolver;
}

/**
 * Initialize the global secrets resolver with custom configuration.
 */
export function initializeGlobalSecretsResolver(
  config: SecretsResolverConfig
): SecretsResolver {
  globalResolver = new DefaultSecretsResolver(config);
  return globalResolver;
}
