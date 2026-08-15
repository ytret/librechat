const { ContentTypes } = require('librechat-data-provider');

/**
 * Tracks wall-clock "thinking" durations per THINK content part.
 *
 * The `createContentAggregator` from `@librechat/agents` builds an ordered
 * `contentParts` array from stream events. A THINK part is "open" while
 * `on_reasoning_delta` events stream into it; it closes when a later non-THINK
 * part (text, tool call, etc.) is appended after it, or when the run ends.
 *
 * We measure the span from the first to the last `on_reasoning_delta` for the
 * currently-open THINK part and stamp it as `thinkDuration` (milliseconds) onto
 * the part itself, so it rides through `saveMessage` into Mongo and survives a
 * page reload.
 *
 * @param {Array<import('librechat-data-provider').TMessageContentParts>} contentParts
 *   The live aggregator array (shared reference with `AgentClient`).
 * @returns {{
 *   wrap: (aggregateContent: Function) => Function,
 *   finalize: () => void,
 * }}
 */
function createThinkTiming(contentParts) {
  /** Index of the currently-open THINK part, or -1 when none is open. */
  let openIndex = -1;
  /** Epoch ms of the first reasoning delta for the open part. */
  let firstSeen = 0;
  /** Epoch ms of the most recent reasoning delta for the open part. */
  let lastSeen = 0;

  const now = () => Date.now();

  /** Index of the last THINK part in the array, or -1. */
  const lastThinkIndex = () => {
    for (let i = contentParts.length - 1; i >= 0; i--) {
      const part = contentParts[i];
      if (part && part.type === ContentTypes.THINK) {
        return i;
      }
    }
    return -1;
  };

  /** Stamp the open part's duration and mark it closed. */
  const close = () => {
    if (openIndex < 0) {
      return;
    }
    const part = contentParts[openIndex];
    if (part && part.type === ContentTypes.THINK && lastSeen >= firstSeen) {
      part.thinkDuration = lastSeen - firstSeen;
    }
    openIndex = -1;
    firstSeen = 0;
    lastSeen = 0;
  };

  /**
   * Wraps the aggregator's `aggregateContent` so timing is recorded around
   * every event. The aggregator runs first (it mutates `contentParts`), then
   * we observe the resulting array to open/close the THINK part.
   * @param {Function} aggregateContent
   * @returns {Function} wrapped aggregateContent with the same signature
   */
  const wrap = (aggregateContent) => (event) => {
    const lengthBefore = contentParts.length;
    aggregateContent(event);

    const evt = event?.event;
    if (evt === 'on_reasoning_delta') {
      const idx = lastThinkIndex();
      if (idx === -1) {
        return;
      }
      const t = now();
      if (idx !== openIndex) {
        openIndex = idx;
        firstSeen = t;
      }
      lastSeen = t;
      return;
    }

    /** A non-reasoning event that appends a new part after the open THINK part
     *  closes it. The open THINK part is always the last THINK entry, so a
     *  grown array whose final entry is no longer THINK means the open part is
     *  now behind a later part. Events that don't append (e.g. `on_run_step`
     *  with `message_creation`) leave the open part untouched. */
    if (contentParts.length > lengthBefore) {
      const lastPart = contentParts[contentParts.length - 1];
      if (lastPart && lastPart.type !== ContentTypes.THINK) {
        close();
      }
    }
  };

  /** Close any still-open THINK part at run end (abort / final). */
  const finalize = () => {
    close();
  };

  return { wrap, finalize };
}

module.exports = { createThinkTiming };
