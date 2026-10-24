import { afterEach, describe, expect, it, vi } from 'vitest';
import { entryOf, redeployed } from '../../demo/src/ui/deploy.ts';

const page = (entry: string) => `<!doctype html><html><head><script type="module" crossorigin src="${entry}"></script></head><body></body></html>`;

const doc = (src: string | null) =>
  ({
    querySelector: (selector: string) => (selector === 'script[type="module"][src]' && src !== null ? { getAttribute: (name: string) => (name === 'src' ? src : null) } : null),
  }) as unknown as Document;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('entryOf', () => {
  it('returns the src attribute of the module script as written in the page, or null without one', () => {
    expect(entryOf(doc('./assets/index-BgbEQ81o.js'))).toBe('./assets/index-BgbEQ81o.js');
    expect(entryOf(doc(''))).toBeNull();
    expect(entryOf(doc(null))).toBeNull();
  });
});

describe('redeployed', () => {
  it('fetches the page without the HTTP cache and is true only when its entry script changed', async () => {
    const fetch = vi.fn(async () => new Response(page('./assets/index-N3wBu1ld.js')));
    vi.stubGlobal('fetch', fetch);
    expect(await redeployed('https://example.test/video-fps-probe/', './assets/index-BgbEQ81o.js')).toBe(true);
    expect(fetch).toHaveBeenCalledWith('https://example.test/video-fps-probe/', { cache: 'no-store' });
    expect(await redeployed('https://example.test/video-fps-probe/', './assets/index-N3wBu1ld.js')).toBe(false);
  });

  it('is false when the page cannot be fetched, answers with an error status, or the running entry is unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    expect(await redeployed('https://example.test/', './assets/index-BgbEQ81o.js')).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<h1>404</h1>', { status: 404 })));
    expect(await redeployed('https://example.test/', './assets/index-BgbEQ81o.js')).toBe(false);
    const fetch = vi.fn(async () => new Response(page('./assets/index-N3wBu1ld.js')));
    vi.stubGlobal('fetch', fetch);
    expect(await redeployed('https://example.test/', null)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
