/**
 * Secrets resolver for fetching API keys and credentials from various platforms.
 * 
 * Supports:
 * - GitHub Secrets (for Actions and app deployments)
 * - Render.com environment variables
 * - Netlify environment variables
 * 
 * This allows secure credential management without hardcoding secrets in configs.
 */

/**
 * Reference to a secret stored in an external system.
 */
export type SecretReference =
  | GitHubSecretReference
  | RenderSecretReference
  | NetlifySecretReference
  | PlainSecretValue;

/**
 * Direct secret value (use with caution; prefer external references).
 */
export interface PlainSecretValue {
  readonly type: 'plain';
  readonly value: string;
}

/**
 * Reference to a GitHub Secret.
 * Available in GitHub Actions contexts and Codespaces.
 */
export interface GitHubSecretReference {
  readonly type: 'github';
  /** GitHub Secrets key name */
  readonly key: string;
  /** Optional: GitHub token for API access (if needed) */
  readonly token?: string;
}

/**
 * Reference to a Render.com environment variable.
 * https://render.com/docs/environment-variables
 */
export interface RenderSecretReference {
  readonly type: 'render';
  /** Environment variable name */
  readonly key: string;
  /** Optional: Render API key for programmatic access */
  readonly apiKey?: string;
  /** Optional: Service ID for scoped lookups */
  readonly serviceId?: string;
}

/**
 * Reference to a Netlify environment variable.
 * https://docs.netlify.com/configure-builds/environment-variables/
 */
export interface NetlifySecretReference {
  readonly type: 'netlify';
  /** Environment variable name */
  readonly key: string;
  /** Optional: Netlify personal access token */
  readonly token?: string;
  /** Optional: Site ID for scoped lookups */
  readonly siteId?: string;
}

/**
 * Result of resolving a secret reference.
 */
export interface ResolvedSecret {
  /** The resolved secret value */
  readonly value: string;
  /** Source where the secret was retrieved from */
  readonly source: string;
  /** When the secret was resolved */
  readonly resolvedAt: Date;
  /** Optional: TTL for caching this secret (in milliseconds) */
  readonly ttl?: number;
}

/**
 * Options for secret resolution.
 */
export interface SecretResolutionOptions {
  /** Whether to cache resolved secrets (default: true) */
  enableCache?: boolean;
  /** Cache TTL in milliseconds (default: 5 minutes) */
  cacheTtl?: number;
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number;
  /** Whether to throw on missing secrets (default: true) */
  throwOnMissing?: boolean;
}

/**
 * Resolves secret references from various external sources.
 */
export interface SecretsResolver {
  /**
   * Resolve a secret reference to its actual value.
   * @param reference - The secret reference
   * @param options - Resolution options
   * @returns The resolved secret, or undefined if not found (when throwOnMissing is false)
   */
  resolve(
    reference: SecretReference,
    options?: SecretResolutionOptions
  ): Promise<ResolvedSecret | undefined>;

  /**
   * Resolve multiple secrets in parallel.
   * @param references - Array of secret references
   * @param options - Resolution options
   * @returns Array of resolved secrets
   */
  resolveMultiple(
    references: SecretReference[],
    options?: SecretResolutionOptions
  ): Promise<(ResolvedSecret | undefined)[]>;

  /**
   * Clear the secrets cache.
   */
  clearCache(): void;

  /**
   * Test if a secret reference is resolvable in the current environment.
   * @param reference - The secret reference to test
   * @returns true if the reference can likely be resolved
   */
  canResolve(reference: SecretReference): Promise<boolean>;
}

/**
 * Detects which secret platforms are available in the current environment.
 */
export interface SecretPlatformDetector {
  /** Whether GitHub Secrets/Actions environment is available */
  readonly hasGitHub: boolean;
  /** Whether Render.com environment is available */
  readonly hasRender: boolean;
  /** Whether Netlify environment is available */
  readonly hasNetlify: boolean;
  /** List of available platforms */
  readonly availablePlatforms: Array<'github' | 'render' | 'netlify'>;
}

/**
 * Configuration for the secrets resolver.
 */
export interface SecretsResolverConfig {
  /** GitHub token for API calls (if needed) */
  githubToken?: string;
  /** Render API key for API calls (if needed) */
  renderApiKey?: string;
  /** Netlify personal access token for API calls (if needed) */
  netlifyToken?: string;
  /** Default cache TTL in milliseconds */
  defaultCacheTtl?: number;
  /** Whether to auto-detect available platforms */
  autoDetect?: boolean;
}
