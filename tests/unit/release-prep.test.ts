import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GENERATED, changelogSection, gitIdentity, localDate, releaseChangelog, unreleasedIntro } from '../../scripts/release-prep.mjs';
import { TARGETS } from '../../scripts/readme-tables.ts';

const CHANGELOG = ['# Changelog', '', 'Intro.', '', '## Unreleased', '', '### Added', '', '- A thing.', '', '## 0.1.0 - 2026-10-24', '', 'First release.', ''].join('\n');

describe('release changelog', () => {
  it('moves the Unreleased section under the version and leaves an empty Unreleased heading', () => {
    const out = releaseChangelog(CHANGELOG, '0.2.0', '2026-11-02');
    expect(out).toBe(['# Changelog', '', 'Intro.', '', '## Unreleased', '', '## 0.2.0 - 2026-11-02', '', '### Added', '', '- A thing.', '', '## 0.1.0 - 2026-10-24', '', 'First release.', ''].join('\n'));
    expect(changelogSection(out, '0.2.0')).toBe('### Added\n\n- A thing.');
    expect(() => releaseChangelog(out, '0.2.1', '2026-11-03')).toThrow(/empty/);
  });

  it('drops the intro before the first ### heading from the released section', () => {
    const withIntro = CHANGELOG.replace('## Unreleased\n\n', '## Unreleased\n\nThese changes go into 0.2.0.\n\nA second note.\n\n');
    expect(unreleasedIntro(withIntro)).toBe('These changes go into 0.2.0.\n\nA second note.');
    expect(releaseChangelog(withIntro, '0.2.0', '2026-11-02')).toBe(releaseChangelog(CHANGELOG, '0.2.0', '2026-11-02'));
    expect(unreleasedIntro(CHANGELOG)).toBe('');
  });

  it('keeps a section without ### headings whole', () => {
    const plain = '## Unreleased\n\nA fix with no subsection.\n';
    expect(unreleasedIntro(plain)).toBe('');
    expect(releaseChangelog(plain, '0.2.1', '2026-11-03')).toBe('## Unreleased\n\n## 0.2.1 - 2026-11-03\n\nA fix with no subsection.\n');
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

  it('refuses a release without a git user.name or user.email and names both values', () => {
    const config = (values: Record<string, string>) => (key: string) => values[key] ?? '';
    expect(gitIdentity(config({ 'user.name': 'Volodymyr Bondarets', 'user.email': 'bondaretsdirect@gmail.com' }))).toBe('Volodymyr Bondarets <bondaretsdirect@gmail.com>');
    expect(() => gitIdentity(config({ 'user.name': 'Volodymyr Bondarets' }))).toThrow('(user.name: Volodymyr Bondarets, user.email: not set)');
    expect(() => gitIdentity(config({}))).toThrow('(user.name: not set, user.email: not set)');
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
