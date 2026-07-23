/**
 * Query-param helpers for `/storage-adapter` deep-links
 * (`stream`, `autoload`, `mode`, `pos`, `eulerDeg`, `fastNav`).
 */

export type DeepLinkVec3 = { x: number; y: number; z: number };

/** `true` / `1` (case-insensitive). */
export const parseTruthyQuery = (raw: string | null | undefined): boolean => {
  if (!raw) {
    return false;
  }
  const value = raw.trim().toLowerCase();
  return value === 'true' || value === '1';
};

/**
 * Parse `[x,y,z]` or `x,y,z` into a finite vec3.
 * Accepts URI-encoded values; returns null when invalid.
 */
export const parseVec3Bracket = (raw: string | null | undefined): DeepLinkVec3 | null => {
  if (raw == null) {
    return null;
  }
  let text = raw.trim();
  if (!text) {
    return null;
  }
  try {
    text = decodeURIComponent(text);
  } catch {
    // Keep raw text when not URI-encoded.
  }
  text = text.trim();
  if (!text.startsWith('[')) {
    text = `[${text}]`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) {
    return null;
  }
  const x = Number(parsed[0]);
  const y = Number(parsed[1]);
  const z = Number(parsed[2]);
  if (![x, y, z].every((n) => Number.isFinite(n))) {
    return null;
  }
  return { x, y, z };
};

export const parseCameraModeQuery = (
  raw: string | null | undefined
): 'fly' | 'orbit' | null => {
  if (!raw) {
    return null;
  }
  const value = raw.trim().toLowerCase();
  if (value === 'fly' || value === 'orbit') {
    return value;
  }
  return null;
};
