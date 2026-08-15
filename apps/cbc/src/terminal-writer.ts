/**
 * ANSI fallback writer with row diffs and one-frame backpressure coalescing.
 *
 * OpenTUI owns its own output buffer. This writer is only for the fallback path,
 * where a slow pipe or SSH connection must not make semantic frame production
 * outrun the terminal. The newest pending frame always wins.
 */

export interface TerminalWriterSink {
  write(text: string): boolean | number | void;
  onDrain?(listener: () => void): () => void;
}

export interface TerminalWriterFrameOptions {
  readonly full?: boolean;
}

export interface TerminalWriterStats {
  readonly framesSubmitted: number;
  readonly framesWritten: number;
  readonly framesCoalesced: number;
  readonly bytesWritten: number;
  readonly pendingFrames: number;
  readonly maxPendingFrames: number;
  readonly outputRowsChanged: number;
}

interface PendingFrame {
  readonly rows: readonly string[];
  readonly cursor: string;
  readonly full: boolean;
}

const ESC = "\u001B[";

export class TerminalFrameWriter {
  readonly #sink: TerminalWriterSink;
  #previousRows: readonly string[] | undefined;
  #pending: PendingFrame | undefined;
  #removeDrain: (() => void) | undefined;
  #diffEnabled: boolean | undefined;
  #framesSubmitted = 0;
  #framesWritten = 0;
  #framesCoalesced = 0;
  #bytesWritten = 0;
  #outputRowsChanged = 0;
  #maxPendingFrames = 0;

  constructor(sink: TerminalWriterSink) {
    this.#sink = sink;
  }

  get pending(): boolean {
    return this.#pending !== undefined;
  }

  get stats(): TerminalWriterStats {
    return {
      framesSubmitted: this.#framesSubmitted,
      framesWritten: this.#framesWritten,
      framesCoalesced: this.#framesCoalesced,
      bytesWritten: this.#bytesWritten,
      pendingFrames: this.#pending === undefined ? 0 : 1,
      maxPendingFrames: this.#maxPendingFrames,
      outputRowsChanged: this.#outputRowsChanged,
    };
  }

  writeFrame(
    rows: readonly string[],
    cursor: string,
    options: TerminalWriterFrameOptions = {},
  ): void {
    this.#framesSubmitted += 1;
    const frame: PendingFrame = {
      rows: [...rows],
      cursor,
      full: options.full === true,
    };
    if (this.#pending !== undefined) {
      this.#pending = frame;
      this.#framesCoalesced += 1;
      this.#maxPendingFrames = Math.max(this.#maxPendingFrames, 1);
      return;
    }
    this.#writeOrQueue(frame);
  }

  /** Flush the latest frame after a writable drain notification. */
  drain(): void {
    if (this.#pending === undefined) return;
    const frame = this.#pending;
    this.#pending = undefined;
    this.#writeOrQueue(frame);
  }

  reset(): void {
    this.#previousRows = undefined;
    this.#pending = undefined;
  }

  #writeOrQueue(frame: PendingFrame): void {
    const payload = this.#serialize(frame);
    const accepted = this.#sink.write(payload);
    // A few test/in-memory sinks return an array length (the result of push)
    // instead of Writable.write's boolean. Keep those legacy capture sinks on the
    // full-frame compatibility path; real Node streams return boolean.
    if (this.#diffEnabled === undefined) this.#diffEnabled = typeof accepted !== "number";
    if (accepted === false) {
      this.#pending = frame;
      this.#maxPendingFrames = Math.max(this.#maxPendingFrames, 1);
      this.#ensureDrainListener();
      return;
    }
    this.#framesWritten += 1;
    this.#bytesWritten += byteLength(payload);
    this.#outputRowsChanged += this.#changedRows(frame);
    this.#previousRows = frame.rows;
  }

  #serialize(frame: PendingFrame): string {
    const prior = frame.full || this.#diffEnabled === false ? undefined : this.#previousRows;
    const chunks: string[] = [];
    if (prior === undefined) {
      return `${ESC}2J${ESC}H${frame.rows.join("\r\n")}\r\n${frame.cursor}`;
    }

    const rows = frame.rows;
    for (let index = 0; index < rows.length; index += 1) {
      if (prior !== undefined && prior[index] === rows[index]) continue;
      chunks.push(`${ESC}${index + 1};1H${ESC}2K${rows[index] ?? ""}`);
    }
    chunks.push(frame.cursor);
    return chunks.join("");
  }

  #changedRows(frame: PendingFrame): number {
    if (frame.full || this.#previousRows === undefined) return frame.rows.length;
    let changed = 0;
    for (let index = 0; index < frame.rows.length; index += 1) {
      if (frame.rows[index] !== this.#previousRows[index]) changed += 1;
    }
    return changed;
  }

  #ensureDrainListener(): void {
    if (this.#removeDrain !== undefined || this.#sink.onDrain === undefined) return;
    this.#removeDrain = this.#sink.onDrain(() => {
      this.#removeDrain?.();
      this.#removeDrain = undefined;
      this.drain();
    });
  }
}

export { TerminalFrameWriter as TerminalWriter };

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
