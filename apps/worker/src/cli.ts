#!/usr/bin/env node
import { executeMilestone5Cli } from './m5-cli.js';

void executeMilestone5Cli(process.argv.slice(2)).then((code) => {
  process.exitCode ??= code;
});
