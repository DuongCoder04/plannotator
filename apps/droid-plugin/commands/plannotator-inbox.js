#!/usr/bin/env node

// Opens the Plannotator Inbox in the browser (starting it in the background
// when it is not running) and prints its address. Returns at once.
const { exitWithFailure, runPlannotator } = require("../lib/run-plannotator");

const result = runPlannotator(["inbox", "--open"]);

if (result.error || result.status !== 0) {
  exitWithFailure(result, "plannotator inbox --open");
}

process.stdout.write(`Your Plannotator Inbox is open in the browser: ${result.stdout.trim()}\n`);
