import { describe, expect, test } from 'vitest';
import { colorName, namedOrUnspecified, VUI_RULE } from '../../src/color/names.ts';

const PRIMARIES: Record<number, string> = { 0: 'reserved', 1: 'bt709', 3: 'reserved', 4: 'bt470m', 5: 'bt470bg', 6: 'smpte170m', 7: 'smpte240m', 8: 'film', 9: 'bt2020', 10: 'smpte428', 11: 'smpte431', 12: 'smpte432', 22: 'ebu3213', 256: 'vgamut' };
const TRANSFERS: Record<number, string> = { 0: 'reserved', 1: 'bt709', 3: 'reserved', 4: 'bt470m', 5: 'bt470bg', 6: 'smpte170m', 7: 'smpte240m', 8: 'linear', 9: 'log100', 10: 'log316', 11: 'iec61966-2-4', 12: 'bt1361e', 13: 'iec61966-2-1', 14: 'bt2020-10', 15: 'bt2020-12', 16: 'smpte2084', 17: 'smpte428', 18: 'arib-std-b67', 256: 'vlog' };
const MATRICES: Record<number, string> = { 0: 'gbr', 1: 'bt709', 3: 'reserved', 4: 'fcc', 5: 'bt470bg', 6: 'smpte170m', 7: 'smpte240m', 8: 'ycgco', 9: 'bt2020nc', 10: 'bt2020c', 11: 'smpte2085', 12: 'chroma-derived-nc', 13: 'chroma-derived-c', 14: 'ictcp', 15: 'ipt-c2', 16: 'ycgco-re', 17: 'ycgco-ro' };

describe('the FFmpeg 8.1 color names', () => {
  for (const [member, table] of [['primaries', PRIMARIES], ['transfer', TRANSFERS], ['space', MATRICES]] as const) {
    test(`${member} names every code ffprobe 8.1.1 names and no other`, () => {
      for (let code = 0; code < 300; code++) {
        expect(colorName(member, code), `${member} ${code}`).toBe(table[code] ?? null);
        expect(namedOrUnspecified(member, code), `${member} ${code}`).toBe(table[code] !== undefined || code === 2 ? code : 2);
      }
      expect(colorName(member, null)).toBeNull();
    });
  }
});

test('the VUI rule is the stage 1 record: the container wins for H.264 and HEVC, and the SPS speaks only when the container is silent', () => {
  expect(VUI_RULE).toEqual({ h264: { colour: 'container-first', range: 'container-first' }, hevc: { colour: 'container-first', range: 'container-first' } });
});
