import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

/**
 * Hidden-input prompt for secrets (D-355). Typed characters are never echoed:
 * readline runs in terminal mode against a muted output while the visible
 * prompt text is written to the real stdout. A `runtime.prompt` adapter
 * (tests, embedders) receives `{ type: 'password', message }` instead.
 */
export function canPromptSecret(io = {}, runtime = {}) {
  if (typeof runtime.prompt === 'function') {
    return true;
  }
  const input = runtime.stdin ?? io.stdin ?? process.stdin;
  return Boolean(input?.isTTY);
}

export async function promptSecret(message, io = {}, runtime = {}) {
  if (typeof runtime.prompt === 'function') {
    return normalizeSecret(await runtime.prompt({ type: 'password', message }));
  }

  const input = runtime.stdin ?? io.stdin ?? process.stdin;
  const output = io.stdout ?? process.stdout;
  if (!input?.isTTY) {
    throw new Error('Secret prompts require an interactive terminal. Pipe the value with --token-stdin instead.');
  }

  output.write(`${message}: `);
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const rl = createInterface({ input, output: muted, terminal: true });
  try {
    return normalizeSecret(await rl.question(''));
  } finally {
    rl.close();
    output.write('\n');
  }
}

/** Reads one secret from stdin: the first non-empty line, trimmed. */
export async function readSecretFromStdin(io = {}, runtime = {}) {
  const input = runtime.stdin ?? io.stdin ?? process.stdin;
  if (typeof input?.setEncoding === 'function') {
    input.setEncoding('utf8');
  }
  let data = '';
  for await (const chunk of input) {
    data += chunk;
  }
  const firstLine = data
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '');
  return firstLine ?? null;
}

function normalizeSecret(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}
