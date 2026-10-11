// SPDX-License-Identifier: AGPL-3.0-only
//
// The app log. Electron writes it to <userData>/logs/app.log; the web build
// keeps the most recent lines in memory (for the debug log view) and echoes
// each line to the browser console. Lines arrive already redacted by
// Desktop's logger (ts/logging/log.std.ts, redactAll).

const MAX_BYTES = 4 * 1024 * 1024;

const lines: Array<string> = [];
let bytes = 0;

const LEVELS: Record<number, 'debug' | 'info' | 'warn' | 'error'> = {
  10: 'debug',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'error',
};

function echo(line: string): void {
  try {
    const { level, time, msg } = JSON.parse(line) as {
      level: number;
      time: string;
      msg: string;
    };
    const method = LEVELS[level] ?? 'info';
    // oxlint-disable-next-line no-console
    console[method](`${time?.slice(11, 23) ?? ''} ${msg}`);
  } catch {
    // oxlint-disable-next-line no-console
    console.log(line);
  }
}

export function appendLogLine(line: string): void {
  const trimmed = line.endsWith('\n') ? line.slice(0, -1) : line;
  lines.push(trimmed);
  bytes += trimmed.length;
  while (bytes > MAX_BYTES && lines.length > 1) {
    bytes -= lines.shift()?.length ?? 0;
  }
  echo(trimmed);
}

export function getLogLines(): ReadonlyArray<string> {
  return lines;
}

export function clearLog(): void {
  lines.length = 0;
  bytes = 0;
}
