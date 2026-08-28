import { formatISOLocalDateTime } from '../datetime';

describe('formatISOLocalDateTime', () => {
  it('formats a date in local time with an extended UTC offset', () => {
    const result = formatISOLocalDateTime('2026-08-28T22:03:12.000Z');

    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  it('returns an empty string for null, undefined, or empty input', () => {
    expect(formatISOLocalDateTime(null)).toBe('');
    expect(formatISOLocalDateTime(undefined)).toBe('');
    expect(formatISOLocalDateTime('')).toBe('');
  });

  it('returns an empty string for an invalid date', () => {
    expect(formatISOLocalDateTime('not-a-date')).toBe('');
  });
});
