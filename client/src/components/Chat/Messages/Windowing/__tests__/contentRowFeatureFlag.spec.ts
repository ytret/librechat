import {
  CONTENT_ROW_WINDOWING_OVERRIDE_STORAGE_KEY,
  DEFAULT_CONTENT_ROW_WINDOWING_ENABLED,
  isContentRowWindowingEnabled,
  parseContentRowWindowingFlag,
  resetContentRowWindowingEnabledForTests,
  setContentRowWindowingEnabled,
} from '../contentRowFeatureFlag';

describe('parseContentRowWindowingFlag', () => {
  it('passes real booleans through', () => {
    expect(parseContentRowWindowingFlag(true)).toBe(true);
    expect(parseContentRowWindowingFlag(false)).toBe(false);
  });

  it('recognizes common truthy and falsy strings, case and space insensitively', () => {
    for (const value of ['1', 'true', 'TRUE', ' on ', 'Yes']) {
      expect(parseContentRowWindowingFlag(value)).toBe(true);
    }
    for (const value of ['0', 'false', 'FALSE', ' off ', 'No', '']) {
      expect(parseContentRowWindowingFlag(value)).toBe(false);
    }
  });

  it('returns null for values that are not a clear boolean', () => {
    expect(parseContentRowWindowingFlag(undefined)).toBeNull();
    expect(parseContentRowWindowingFlag(null)).toBeNull();
    expect(parseContentRowWindowingFlag(1)).toBeNull();
    expect(parseContentRowWindowingFlag('maybe')).toBeNull();
    expect(parseContentRowWindowingFlag({})).toBeNull();
  });
});

describe('content-row windowing flag', () => {
  afterEach(() => {
    resetContentRowWindowingEnabledForTests();
    window.localStorage.removeItem(CONTENT_ROW_WINDOWING_OVERRIDE_STORAGE_KEY);
  });

  it('defaults to off so Stage 2 never windows a production row', () => {
    expect(DEFAULT_CONTENT_ROW_WINDOWING_ENABLED).toBe(false);
    expect(isContentRowWindowingEnabled()).toBe(false);
  });

  it('honours a development override and reports the value now in effect', () => {
    const dev = { isDevelopment: true };
    expect(setContentRowWindowingEnabled(true, dev)).toBe(true);
    expect(isContentRowWindowingEnabled(dev)).toBe(true);
    expect(setContentRowWindowingEnabled(false, dev)).toBe(false);
    expect(isContentRowWindowingEnabled(dev)).toBe(false);
  });

  it('clears the override back to the build default with null', () => {
    const dev = { isDevelopment: true };
    setContentRowWindowingEnabled(true, dev);
    expect(setContentRowWindowingEnabled(null, dev)).toBe(DEFAULT_CONTENT_ROW_WINDOWING_ENABLED);
  });

  it('persists the development override so a reload keeps the chosen state', () => {
    setContentRowWindowingEnabled(true, { isDevelopment: true });
    expect(window.localStorage.getItem(CONTENT_ROW_WINDOWING_OVERRIDE_STORAGE_KEY)).toBe('true');
    setContentRowWindowingEnabled(null, { isDevelopment: true });
    expect(window.localStorage.getItem(CONTENT_ROW_WINDOWING_OVERRIDE_STORAGE_KEY)).toBeNull();
  });

  it('restores a persisted development override on first read', () => {
    window.localStorage.setItem(CONTENT_ROW_WINDOWING_OVERRIDE_STORAGE_KEY, 'true');
    resetContentRowWindowingEnabledForTests();
    expect(isContentRowWindowingEnabled({ isDevelopment: true })).toBe(true);
  });

  it('is a no-op in production builds, so a release cannot be toggled at runtime', () => {
    setContentRowWindowingEnabled(true, { isDevelopment: true });
    const production = { isDevelopment: false };
    expect(setContentRowWindowingEnabled(true, production)).toBe(
      DEFAULT_CONTENT_ROW_WINDOWING_ENABLED,
    );
    // an override set in development must not leak into a production read
    expect(isContentRowWindowingEnabled(production)).toBe(DEFAULT_CONTENT_ROW_WINDOWING_ENABLED);
  });
});
