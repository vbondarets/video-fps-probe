import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LATEST, latestPins, lockedOverrides, pinDrift, REACT_18_PINS } from '../../scripts/consumers.mjs';

const dirs: string[] = [];

function consumers(packages: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'video-fps-probe-pins-'));
  dirs.push(dir);
  for (const [path, version] of Object.entries(packages)) {
    const name = path.split('/node_modules/').pop()!.replace(/^(?:react18\/)?node_modules\//, '');
    mkdirSync(join(dir, path), { recursive: true });
    writeFileSync(join(dir, path, 'package.json'), JSON.stringify({ name, version }));
  }
  return dir;
}

const react18 = (): Record<string, string> => Object.fromEntries(Object.entries(REACT_18_PINS).map(([name, version]) => [`react18/node_modules/${name}`, version]));

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('consumers: pinned versions', () => {
  const rolldown = lockedOverrides().rolldown!;

  it('passes an install where every copy matches its pin', () => {
    expect(rolldown).toMatch(/^\d+\.\d+\.\d+/);
    expect(pinDrift(consumers({ 'node_modules/rolldown': rolldown, 'node_modules/vite/node_modules/rolldown': rolldown, 'node_modules/unpinned': '9.9.9', ...react18() }))).toEqual([]);
  });

  it('fails a top-level copy, a nested copy and a scoped nested copy that differ from the pin', () => {
    const dir = consumers({
      'node_modules/rolldown': '0.0.1',
      'node_modules/vite/node_modules/rolldown': '0.0.2',
      'node_modules/@scope/tool/node_modules/rolldown': '0.0.3',
      ...react18(),
    });
    expect(pinDrift(dir).sort()).toEqual(
      ['node_modules/rolldown', 'node_modules/vite/node_modules/rolldown', 'node_modules/@scope/tool/node_modules/rolldown']
        .map((path, i) => `consumers: rolldown 0.0.${i + 1} is installed at ${join(path)}, the pin is ${rolldown}; run npm run consumers:setup`)
        .sort(),
    );
  });

  it('checks a --latest install against latest.json instead of package-lock.json', () => {
    const latest = { vite: '99.0.0', mp4box: '99.1.0', mediabunny: '99.2.0', rolldown: '99.3.0' };
    const dir = consumers({ 'node_modules/vite': latest.vite, 'node_modules/rolldown': latest.rolldown, 'node_modules/vite/node_modules/rolldown': rolldown, 'node_modules/mp4box': latest.mp4box, ...react18() });
    writeFileSync(join(dir, 'latest.json'), JSON.stringify(latest));
    expect(latestPins(dir)).toEqual(latest);
    expect(LATEST.every((name) => Object.hasOwn(latest, name))).toBe(true);
    expect(pinDrift(dir)).toEqual([`consumers: rolldown ${rolldown} is installed at ${join('node_modules/vite/node_modules/rolldown')}, the pin is ${latest.rolldown}; run npm run consumers:setup`]);
  });

  it('fails a react18 package at another version, nested or not, and one that is missing', () => {
    const installed = react18();
    delete installed['react18/node_modules/react-dom'];
    const dir = consumers({ ...installed, 'react18/node_modules/scheduler': '0.23.0', 'react18/node_modules/react/node_modules/loose-envify': '1.3.0' });
    expect(pinDrift(dir).sort()).toEqual(
      [
        `consumers: loose-envify 1.3.0 is installed at ${join('react18/node_modules/react/node_modules/loose-envify')}, the pin is ${REACT_18_PINS['loose-envify']}; run npm run consumers:setup`,
        `consumers: react-dom is not installed in ${join('react18/node_modules')}, the pin is ${REACT_18_PINS['react-dom']}; run npm run consumers:setup`,
        `consumers: scheduler 0.23.0 is installed at ${join('react18/node_modules/scheduler')}, the pin is ${REACT_18_PINS.scheduler}; run npm run consumers:setup`,
      ].sort(),
    );
  });
});
