import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GENERATED, changelogSection, localDate, releaseChangelog } from '../../scripts/release-prep.mjs';
import { TARGETS } from '../../scripts/readme-tables.ts';

const CHANGELOG = ['# Changelog', '', 'Intro.', '', '## Unreleased', '', '### Added', '', '- A thing.', '', '## 0.1.0 - 2026-10-24', '', 'First release.', ''].join('\n');

describe('release changelog', () => {
  it('moves the Unreleased section under the version and leaves an empty Unreleased heading', () => {
    const out = releaseChangelog(CHANGELOG, '0.2.0', '2026-11-02');
    expect(out).toBe(['# Changelog', '', 'Intro.', '', '## Unreleased', '', '## 0.2.0 - 2026-11-02', '', '### Added', '', '- A thing.', '', '## 0.1.0 - 2026-10-24', '', 'First release.', ''].join('\n'));
    expect(changelogSection(out, '0.2.0')).toBe('### Added\n\n- A thing.');
    expect(() => releaseChangelog(out, '0.2.1', '2026-11-03')).toThrow(/empty/);
  });

  it('keeps CRLF line ends and a section that is the last one', () => {
    const out = releaseChangelog('## Unreleased\r\n- Fix.\r\n', '1.0.0', '2027-01-01');
    expect(out).toBe('## Unreleased\r\n\r\n## 1.0.0 - 2027-01-01\r\n\r\n- Fix.\r\n');
  });

  it('refuses a missing Unreleased heading, an empty section and a version that already has one', () => {
    expect(() => releaseChangelog('# Changelog\n', '0.2.0', '2026-11-02')).toThrow(/no "## Unreleased" heading/);
    expect(() => releaseChangelog('## Unreleased\n\n\n## 0.1.0\n', '0.2.0', '2026-11-02')).toThrow(/empty/);
    expect(() => releaseChangelog(CHANGELOG, '0.1.0', '2026-11-02')).toThrow(/already has a 0.1.0 section/);
    expect(() => changelogSection(CHANGELOG, '0.3.0')).toThrow(/no 0.3.0 section/);
  });

  it('dates the section from the local clock', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  it('reads the committed changelog', () => {
    const text = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
    expect(changelogSection(text, '0.1.0')).toMatch(/^First release/);
  });

  it('stages every file the doc tables write', () => {
    for (const { path } of TARGETS) expect(GENERATED).toContain(path);
  });
});
