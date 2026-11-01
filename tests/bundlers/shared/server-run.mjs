import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import process from 'node:process';
import { SERVER_ENTRIES, serverRun } from './server-run-core.mjs';

const [file, out] = process.argv.slice(2);
const mods = {};
for (const [key, specifier] of Object.entries(SERVER_ENTRIES)) mods[key] = await import(specifier);
const resolved = Object.values(SERVER_ENTRIES).map((specifier) => import.meta.resolve(specifier));
const run = await serverRun(mods, new Uint8Array(readFileSync(file)), basename(file));
const json = JSON.stringify({ loader: 'import', resolved, run });
if (out) writeFileSync(out, json);
else process.stdout.write(json);
