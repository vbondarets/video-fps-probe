export function parseBrowserFlags(value) {
  return (value ?? '').split(/\s+/).filter(Boolean);
}

export function headlessMode(exe, flags = []) {
  const name = (exe ?? '').split(/[\\/]/).pop() ?? '';
  const mode = /headless[-_]shell/i.test(name) ? `${name.replace(/\.exe$/i, '')} (the old headless mode)` : 'headless=new';
  return flags.length > 0 ? `${mode}, extra flags ${flags.join(' ')}` : mode;
}

export function commandLine(script, argv, flags = []) {
  const env = flags.length > 0 ? `BENCH_BROWSER_FLAGS="${flags.join(' ')}" ` : '';
  return `${env}node ${script} ${argv.join(' ')}`.trim();
}
