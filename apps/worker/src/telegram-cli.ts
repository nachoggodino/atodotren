#!/usr/bin/env node
import { executeTelegramOperationsCli } from './telegram-operations.js';

void executeTelegramOperationsCli().then((code) => {
  process.exitCode ??= code;
});
