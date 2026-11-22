#!/usr/bin/env node
// A hook or MCP fixture for the relay's capability checks: once started it
// appends a line to its marker file, then keeps running for a set time, so a
// watcher outside the tool sees it in the process table. Its token is on its
// command line. `node relay-check-fixture.js <marker> <token> [seconds]`.
import { appendFileSync } from 'node:fs';

const [marker, token, seconds = '20'] = process.argv.slice(2);
try {
  appendFileSync(marker, `${token} ${process.pid} ${new Date().toISOString()}\n`);
} catch {
  // A refused write leaves no marker; the watcher still sees this process.
}
process.stdin.on('data', () => {});
process.stdin.on('error', () => {});
setTimeout(() => process.exit(0), Number(seconds) * 1000);
