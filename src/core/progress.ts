/**
 * Host-neutral progress reporter.
 *
 * Provides visual feedback during long-running bridge calls (decompose,
 * design) by emitting periodic onUpdate callbacks with elapsed time and a
 * status label.  The bridge protocol is request→response (no streaming),
 * so this is purely client-side: it shows the user something is happening
 * while we wait.
 */

export interface ProgressUpdate {
  content: Array<{ type: "text"; text: string }>;
  details: { progress: true; elapsed_seconds: number; label: string };
}

export type ProgressCallback = (partial: ProgressUpdate) => void;

export interface ProgressHandle {
  stop: () => void;
  /** Update the status label (e.g. "Decomposing HLR…"). */
  setLabel: (label: string) => void;
}

export function startProgress(
  onUpdate: ProgressCallback | undefined,
  label: string,
  intervalMs = 3000,
): ProgressHandle {
  if (!onUpdate) return { stop: () => {}, setLabel: () => {} };
  const start = Date.now();
  let currentLabel = label;

  const emit = () => {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const timeStr = mins > 0 ? `${mins}m${secs.toString().padStart(2, "0")}s` : `${secs}s`;
    onUpdate({
      content: [{ type: "text", text: `⏳ ${currentLabel} (${timeStr})` }],
      details: { progress: true, elapsed_seconds: elapsed, label: currentLabel },
    });
  };

  emit(); // immediate first update
  const timer = setInterval(emit, intervalMs);

  return {
    stop: () => clearInterval(timer),
    setLabel: (l: string) => { currentLabel = l; },
  };
}
