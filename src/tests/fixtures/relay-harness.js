#!/usr/bin/env node
// Runs the relay in a process of its own, for tests that kill it mid-turn.
// `node relay-harness.js '<options json>' '<supported versions json>' <homedir>`.
// The version list is passed programmatically, as the tests' only seam.
import { runReviewRelay } from '../../review-relay.js';

const [optionsJson, supportedJson, homedir] = process.argv.slice(2);
const options = JSON.parse(optionsJson);
const result = await runReviewRelay(options, {
  io: { stdout: process.stdout, stderr: process.stderr },
  env: process.env,
  platform: 'darwin',
  supportedReviewerVersions: JSON.parse(supportedJson),
  userInfo: { homedir },
  confirm: null,
});
process.exitCode = result.exitCode;
