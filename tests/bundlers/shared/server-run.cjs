'use strict';
const { readFileSync, writeFileSync } = require('node:fs');
const { basename } = require('node:path');
const process = require('node:process');

async function main() {
  const { SERVER_ENTRIES, serverRun } = await import('./server-run-core.mjs');
  const [file, out] = process.argv.slice(2);
  const mods = {};
  const resolved = [];
  const sharedWithImport = [];
  for (const [key, specifier] of Object.entries(SERVER_ENTRIES)) {
    mods[key] = require(specifier);
    resolved.push(require.resolve(specifier));
    const esm = await import(specifier);
    sharedWithImport.push(Object.keys(esm).every((name) => esm[name] === mods[key][name]));
  }
  const run = await serverRun(mods, new Uint8Array(readFileSync(file)), basename(file));
  const json = JSON.stringify({ loader: 'require', resolved, sharedWithImport, run });
  if (out) writeFileSync(out, json);
  else process.stdout.write(json);
}

main().catch((e) => {
  process.stderr.write(`${e && e.stack ? e.stack : e}\n`);
  process.exitCode = 1;
});
