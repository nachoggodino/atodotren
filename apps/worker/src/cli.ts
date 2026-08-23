#!/usr/bin/env node
import { executeMilestone4Cli } from './m4-cli.js';

void executeMilestone4Cli(process.argv.slice(2)).then((code) => {
  process.exitCode ??= code;
});
