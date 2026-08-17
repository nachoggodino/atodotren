#!/usr/bin/env node
import { executeCli } from './dispatcher.js';

void executeCli(process.argv.slice(2)).then((code) => {
  process.exitCode ??= code;
});
