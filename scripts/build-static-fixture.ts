#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createFixtureZip } from '../tests/helpers/zip.ts';

const source = resolve('tests/fixtures/gtfs-static/representative');
const target = resolve('tests/fixtures/gtfs-static/representative.zip');
await writeFile(target, await createFixtureZip(source), { mode: 0o600 });
process.stdout.write(`Built ${target}\n`);
