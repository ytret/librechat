/**
 * Formats a wall-clock "thinking" duration (milliseconds) into a compact,
 * human-readable string for the collapsed "Thoughts" header.
 *
 * Rules (per product decision):
 *  - >= 60s, whole minute:        "2m"      (no trailing "0s")
 *  - >= 60s, with seconds:        "3m 5s"
 *  - >= 1s, under a minute:       "45s"
 *  - < 1s:                        "<1s"
 *
 * @param ms - Duration in milliseconds (integer, backend-computed).
 * @returns Formatted duration string, or `null` if the input is not a valid number.
 */
export function formatThinkDuration(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    return null;
  }

  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 1) {
    return '<1s';
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes < 1) {
    return `${seconds}s`;
  }

  if (seconds === 0) {
    return `${minutes}m`;
  }

  return `${minutes}m ${seconds}s`;
}
