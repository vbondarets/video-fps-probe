import { describe, expect, test } from 'vitest';
import { HASH_PLACEHOLDER, hashNormalizer, normalizedName } from '../../scripts/size-matrix.mjs';

describe('hash-normalized sizes', () => {
  test('replace the content hash of every emitted name with a placeholder of the same length', () => {
    const names = ['assets/isobmff-BGGTJ-Da.js', 'assets/isobmff-BGGTJ-Da.js.map', 'assets/own-matroska.worker-Dogy1Iw-.js', 'assets/probe-client-Bx0Cv-8G.js', 'index.html', 'own-isobmff.worker.js'];
    expect(HASH_PLACEHOLDER).toBe('00000000');
    expect(names.map(normalizedName)).toEqual(['assets/isobmff-00000000.js', 'assets/isobmff-00000000.js.map', 'assets/own-matroska.worker-00000000.js', 'assets/probe-client-00000000.js', 'index.html', 'own-isobmff.worker.js']);
    const normalize = hashNormalizer(names);
    const text = 'import("./isobmff-BGGTJ-Da.js");new URL("own-matroska.worker-Dogy1Iw-.js",import.meta.url);"assets/probe-client-Bx0Cv-8G.js";//# sourceMappingURL=isobmff-BGGTJ-Da.js.map BGGTJ-Da';
    const out = normalize(text);
    expect(out).toBe('import("./isobmff-00000000.js");new URL("own-matroska.worker-00000000.js",import.meta.url);"assets/probe-client-00000000.js";//# sourceMappingURL=isobmff-00000000.js.map BGGTJ-Da');
    expect(out).toHaveLength(text.length);
    expect(normalize(out)).toBe(out);
    expect(hashNormalizer(['index.html'])(text)).toBe(text);
  });
});
