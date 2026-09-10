/**
 * Feature flag for content-row windowing.
 *
 * Spec: `ai-reports/09-content-row-dom-windowing-spec.md` §19 Stage 5 rollback —
 * "one feature flag makes all content rows mounted without changing message markup
 * or behavior" — and the Stage 2 plan (`ai-reports/12-stage-2-provider-infrastructure.md`
 * §3.2).
 *
 * Default is **off** until Stage 5 acceptance. `VirtualizedContentRow` consults this
 * flag: when it is off, a row renders its children unconditionally as a plain `div`
 * with no virtual-row attributes and performs no registration, so the DOM is
 * indistinguishable from the non-windowed tree.
 *
 * Resolution order (first match wins):
 *
 * 1. in-memory override (`setContentRowWindowingEnabled`), development-only and
 *    mirrored to `localStorage` so a reload keeps the chosen state while iterating;
 * 2. `VITE_CONTENT_ROW_WINDOWING`;
 * 3. `DEFAULT_CONTENT_ROW_WINDOWING_ENABLED` (false).
 *
 * The override is only honoured in development builds, so a shipped release cannot be
 * toggled at runtime. `isDevelopment` is injectable, following the `QueryDevtoolsGate`
 * pattern already used in this codebase.
 */

export const DEFAULT_CONTENT_ROW_WINDOWING_ENABLED = false;

export const CONTENT_ROW_WINDOWING_OVERRIDE_STORAGE_KEY = 'lc:content-row-windowing';

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);
const FALSY = new Set(['0', 'false', 'off', 'no', '']);

export type ContentRowWindowingFlagOptions = {
  /** Defaults to `import.meta.env.DEV`. */
  isDevelopment?: boolean;
};

/** Parse an external flag representation. Returns null when it is not a clear boolean. */
export function parseContentRowWindowingFlag(value: unknown): boolean | null {
  if (value === true || value === false) {
    return value;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (TRUTHY.has(normalized)) {
    return true;
  }
  if (FALSY.has(normalized)) {
    return false;
  }
  return null;
}

function isDevelopmentBuild(): boolean {
  return import.meta.env.DEV === true;
}

function readEnvironmentFlag(): boolean | null {
  return parseContentRowWindowingFlag(import.meta.env.VITE_CONTENT_ROW_WINDOWING);
}

function readStoredOverride(isDevelopment: boolean): boolean | null {
  if (!isDevelopment || typeof window === 'undefined') {
    return null;
  }
  try {
    return parseContentRowWindowingFlag(
      window.localStorage?.getItem(CONTENT_ROW_WINDOWING_OVERRIDE_STORAGE_KEY),
    );
  } catch {
    // localStorage can throw in private/embedded contexts; the flag must still resolve.
    return null;
  }
}

let runtimeOverride: boolean | null = null;
let overrideLoaded = false;

export function isContentRowWindowingEnabled(options?: ContentRowWindowingFlagOptions): boolean {
  const isDevelopment = options?.isDevelopment ?? isDevelopmentBuild();
  if (!overrideLoaded && isDevelopment) {
    runtimeOverride = readStoredOverride(true);
    overrideLoaded = true;
  }
  if (isDevelopment && runtimeOverride !== null) {
    return runtimeOverride;
  }
  const fromEnvironment = readEnvironmentFlag();
  if (fromEnvironment !== null) {
    return fromEnvironment;
  }
  return DEFAULT_CONTENT_ROW_WINDOWING_ENABLED;
}

/**
 * Set (or clear, with `null`) the development override. A no-op in production builds.
 * Returns the flag value that is now in effect.
 */
export function setContentRowWindowingEnabled(
  enabled: boolean | null,
  options?: ContentRowWindowingFlagOptions,
): boolean {
  const isDevelopment = options?.isDevelopment ?? isDevelopmentBuild();
  if (isDevelopment) {
    runtimeOverride = enabled;
    overrideLoaded = true;
    if (typeof window !== 'undefined') {
      try {
        if (enabled === null) {
          window.localStorage?.removeItem(CONTENT_ROW_WINDOWING_OVERRIDE_STORAGE_KEY);
        } else {
          window.localStorage?.setItem(CONTENT_ROW_WINDOWING_OVERRIDE_STORAGE_KEY, String(enabled));
        }
      } catch {
        // Persistence is a convenience; the in-memory override is authoritative.
      }
    }
  }
  return isContentRowWindowingEnabled(options);
}

/** Test seam: forget the in-memory override without touching storage. */
export function resetContentRowWindowingEnabledForTests(): void {
  runtimeOverride = null;
  overrideLoaded = false;
}
