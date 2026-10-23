import { afterEach, describe, expect, it, vi } from 'vitest';
import { version } from '../../package.json';
import type { FileResult } from '../../src/core/types.ts';
import {
  EXPORT_FILE_NAME,
  EXPORT_SCHEMA,
  buildExport,
  entryChunk,
  collectEnvironment,
  describeEnvironment,
  exportResults,
  readHighEntropy,
  type EnvironmentGlobals,
  type ExportRow,
  type HighEntropy,
  type UserAgentDataLike,
} from '../../demo/src/ui/deviceInfo.ts';

const NOW = new Date('2026-10-21T12:34:56.789Z');

const UA = {
  chromeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  headlessChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36',
  edgeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0',
  firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:150.0) Gecko/20100101 Firefox/150.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  chromeIpad: 'Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/155.0.7000.100 Mobile/15E148 Safari/604.1',
  firefoxIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/150.0 Mobile/15E148 Safari/605.1.15',
  chromeAndroidReduced:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36',
  samsungAndroid:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:150.0) Gecko/150.0 Firefox/150.0',
  chromeOs: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  unknown: 'SomeCrawler/1.0',
};

const BRANDS = {
  chrome: [
    { brand: 'Not A;Brand', version: '99' },
    { brand: 'Chromium', version: '155' },
    { brand: 'Google Chrome', version: '155' },
  ],
  edge: [
    { brand: 'Microsoft Edge', version: '155' },
    { brand: 'Chromium', version: '155' },
    { brand: 'Not_A Brand', version: '24' },
  ],
  brave: [
    { brand: 'Brave', version: '155' },
    { brand: 'Chromium', version: '155' },
    { brand: 'Not)A;Brand', version: '99' },
  ],
  chromiumOnly: [
    { brand: 'Not/A)Brand', version: '8' },
    { brand: 'Chromium', version: '155' },
  ],
};

function fake(
  userAgent: string,
  extra: Partial<EnvironmentGlobals['navigator']> = {},
  rest: Partial<Omit<EnvironmentGlobals, 'navigator'>> = {},
): EnvironmentGlobals {
  return { navigator: { userAgent, ...extra }, ...rest };
}

const uaData = (platform: string, mobile = false): UserAgentDataLike => ({ brands: [], mobile, platform });

const line = (g: EnvironmentGlobals, high: HighEntropy | null = null): string => describeEnvironment(collectEnvironment(g, NOW, high));

const high = (p: Partial<HighEntropy>): HighEntropy => ({ platformVersion: null, model: null, architecture: null, bitness: null, ...p });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('collectEnvironment', () => {
  it('reads every field from a fake desktop Chrome', () => {
    const g: EnvironmentGlobals = {
      navigator: {
        userAgent: UA.chromeWindows,
        userAgentData: { brands: BRANDS.chrome, mobile: false, platform: 'Windows' },
        platform: 'Win32',
        language: 'en-GB',
        hardwareConcurrency: 16,
        deviceMemory: 8,
        maxTouchPoints: 0,
      },
      screen: { width: 1536, height: 864 },
      innerWidth: 1200,
      innerHeight: 700,
      devicePixelRatio: 1.25,
      crossOriginIsolated: false,
    };
    const env = collectEnvironment(g, NOW, high({ platformVersion: '15.0.0', model: '', architecture: 'x86', bitness: '64' }));
    expect(env).toEqual({
      userAgent: UA.chromeWindows,
      userAgentData: {
        brands: BRANDS.chrome,
        mobile: false,
        platform: 'Windows',
        platformVersion: '15.0.0',
        model: '',
        architecture: 'x86',
        bitness: '64',
      },
      platform: 'Win32',
      language: 'en-GB',
      hardwareConcurrency: 16,
      deviceMemory: 8,
      maxTouchPoints: 0,
      screen: { width: 1536, height: 864, devicePixelRatio: 1.25 },
      viewport: { width: 1200, height: 700 },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      crossOriginIsolated: false,
      timestamp: '2026-10-21T12:34:56.789Z',
    });
  });

  it('uses null for everything a browser does not provide', () => {
    const env = collectEnvironment(fake(UA.safariIphone), NOW);
    expect(env).toMatchObject({
      userAgent: UA.safariIphone,
      userAgentData: null,
      platform: null,
      language: null,
      hardwareConcurrency: null,
      deviceMemory: null,
      maxTouchPoints: null,
      screen: null,
      viewport: null,
      crossOriginIsolated: null,
      timestamp: '2026-10-21T12:34:56.789Z',
    });
  });

  it('ignores non-finite numbers and defaults the pixel ratio to 1', () => {
    const g = fake(UA.chromeWindows, { hardwareConcurrency: Number.NaN }, { screen: { width: 800, height: 600 }, innerWidth: Number.POSITIVE_INFINITY, innerHeight: 5 });
    const env = collectEnvironment(g, NOW);
    expect(env.hardwareConcurrency).toBeNull();
    expect(env.screen).toEqual({ width: 800, height: 600, devicePixelRatio: 1 });
    expect(env.viewport).toBeNull();
  });

  it('keeps userAgentData fields null when the browser exposes only part of the API', () => {
    const env = collectEnvironment(fake(UA.chromeWindows, { userAgentData: {} }), NOW);
    expect(env.userAgentData).toEqual({
      brands: [],
      mobile: null,
      platform: null,
      platformVersion: null,
      model: null,
      architecture: null,
      bitness: null,
    });
  });

  it('copies brands so later changes to the navigator do not leak into the snapshot', () => {
    const brands = [{ brand: 'Google Chrome', version: '155' }];
    const env = collectEnvironment(fake(UA.chromeWindows, { userAgentData: { brands, mobile: false, platform: 'Windows' } }), NOW);
    brands[0]!.version = '1';
    expect(env.userAgentData?.brands).toEqual([{ brand: 'Google Chrome', version: '155' }]);
  });

  it('takes the timestamp from the supplied date', () => {
    expect(collectEnvironment(fake(UA.chromeWindows), new Date(0)).timestamp).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('describeEnvironment', () => {
  it.each<[string, EnvironmentGlobals, HighEntropy | null, string]>([
    ['Chrome on Windows from the UA string', fake(UA.chromeWindows, { hardwareConcurrency: 16 }), null, 'Chrome 155 on Windows, 16 threads'],
    ['headless Chrome', fake(UA.headlessChrome, { hardwareConcurrency: 4 }), null, 'Chrome 155 on Windows, 4 threads'],
    ['Edge from the UA string', fake(UA.edgeWindows, { hardwareConcurrency: 8 }), null, 'Edge 155 on Windows, 8 threads'],
    ['Firefox on macOS', fake(UA.firefoxMac, { hardwareConcurrency: 10 }), null, 'Firefox 150 on macOS, 10 threads'],
    ['Firefox on Linux', fake(UA.firefoxLinux, { hardwareConcurrency: 1 }), null, 'Firefox 150 on Linux, 1 thread'],
    ['Safari on macOS keeps the minor version', fake(UA.safariMac, { hardwareConcurrency: 8 }), null, 'Safari 18.1 on macOS, 8 threads'],
    ['Chrome on macOS', fake(UA.chromeMac), null, 'Chrome 155 on macOS'],
    [
      'Safari on iPhone with screen',
      fake(UA.safariIphone, { hardwareConcurrency: 6 }, { screen: { width: 390, height: 844 }, devicePixelRatio: 3 }),
      null,
      'Safari 18.1 on iOS 18.1, 6 threads, 390x844 @3x',
    ],
    [
      'Safari on iPad requesting the desktop site',
      fake(UA.safariMac, { maxTouchPoints: 5, hardwareConcurrency: 8 }),
      null,
      'Safari 18.1 on iPadOS, 8 threads',
    ],
    ['Chrome on iPad', fake(UA.chromeIpad), null, 'Chrome 155 on iPadOS 18.1'],
    ['Firefox on iPhone', fake(UA.firefoxIphone), null, 'Firefox 150 on iOS 17.6'],
    ['Chrome on Android hides the reduced OS version', fake(UA.chromeAndroidReduced, { hardwareConcurrency: 8 }), null, 'Chrome 155 on Android, 8 threads'],
    [
      'Chrome on Android with high entropy values',
      fake(UA.chromeAndroidReduced, { hardwareConcurrency: 8, userAgentData: uaData('Android', true) }),
      high({ platformVersion: '14.0.0', model: 'Pixel 8' }),
      'Chrome 155 on Android 14 (Pixel 8), 8 threads',
    ],
    ['Samsung Internet', fake(UA.samsungAndroid), null, 'Samsung Internet 27 on Android'],
    ['Firefox on Android shows the real OS version', fake(UA.firefoxAndroid), null, 'Firefox 150 on Android 14'],
    ['ChromeOS', fake(UA.chromeOs), null, 'Chrome 155 on ChromeOS'],
    ['Windows 11 from the platform version', fake(UA.chromeWindows, { hardwareConcurrency: 16, userAgentData: uaData('Windows') }), high({ platformVersion: '19.0.0' }), 'Chrome 155 on Windows 11, 16 threads'],
    ['Windows 10 from the platform version', fake(UA.chromeWindows, { userAgentData: uaData('Windows') }), high({ platformVersion: '10.0.0' }), 'Chrome 155 on Windows 10'],
    ['macOS version from the platform version', fake(UA.chromeMac, { userAgentData: uaData('macOS') }), high({ platformVersion: '14.5.0' }), 'Chrome 155 on macOS 14.5'],
    ['an empty model is not shown', fake(UA.chromeWindows, { userAgentData: uaData('Windows') }), high({ model: '' }), 'Chrome 155 on Windows'],
    ['an unknown agent', fake(UA.unknown), null, 'Unknown browser'],
    [
      'fractional pixel ratio',
      fake(UA.chromeWindows, { hardwareConcurrency: 12 }, { screen: { width: 1536, height: 864 }, devicePixelRatio: 1.25 }),
      null,
      'Chrome 155 on Windows, 12 threads, 1536x864 @1.25x',
    ],
  ])('%s', (_name, g, extra, expected) => {
    expect(line(g, extra)).toBe(expected);
  });

  it.each<[string, readonly { brand: string; version: string }[], string]>([
    ['Chrome', BRANDS.chrome, 'Chrome 155 on Windows'],
    ['Edge', BRANDS.edge, 'Edge 155 on Windows'],
    ['Brave', BRANDS.brave, 'Brave 155 on Windows'],
    ['Chromium only', BRANDS.chromiumOnly, 'Chromium 155 on Windows'],
  ])('prefers userAgentData brands: %s', (_name, brands, expected) => {
    const data: UserAgentDataLike = { brands, mobile: false, platform: 'Windows' };
    expect(line(fake(UA.chromeWindows, { userAgentData: data }))).toBe(expected);
  });

  it('falls back to the UA string when the brand list holds only a GREASE entry', () => {
    const data: UserAgentDataLike = { brands: [{ brand: 'Not.A/Brand', version: '8' }], mobile: false, platform: 'Windows' };
    expect(line(fake(UA.chromeWindows, { userAgentData: data }))).toBe('Chrome 155 on Windows');
  });

  it('falls back to the reported platform when the UA names no known OS', () => {
    expect(line(fake(UA.unknown, { platform: 'Plan9' }))).toBe('Unknown browser on Plan9');
    const data: UserAgentDataLike = { brands: [], platform: 'Fuchsia' };
    expect(line(fake(UA.unknown, { userAgentData: data, platform: 'Plan9' }))).toBe('Unknown browser on Fuchsia');
  });

  it('does not mistake an iPhone for a Mac', () => {
    expect(line(fake(UA.safariIphone))).toContain('iOS 18.1');
    expect(line(fake(UA.safariIphone))).not.toContain('macOS');
  });

  it('does not mistake a touchless Mac for an iPad', () => {
    expect(line(fake(UA.safariMac, { maxTouchPoints: 0 }))).toBe('Safari 18.1 on macOS');
  });
});

describe('readHighEntropy', () => {
  it('requests the four hints and keeps only strings', async () => {
    const getHighEntropyValues = vi.fn().mockResolvedValue({
      platformVersion: '14.0.0',
      model: 'Pixel 8',
      architecture: '',
      bitness: 64,
      fullVersionList: [],
    });
    const result = await readHighEntropy({ userAgent: UA.chromeAndroidReduced, userAgentData: { getHighEntropyValues } });
    expect(getHighEntropyValues).toHaveBeenCalledWith(['platformVersion', 'model', 'architecture', 'bitness']);
    expect(result).toEqual({ platformVersion: '14.0.0', model: 'Pixel 8', architecture: '', bitness: null });
  });

  it('returns null when the browser has no such API', async () => {
    expect(await readHighEntropy({ userAgent: UA.safariIphone })).toBeNull();
    expect(await readHighEntropy({ userAgent: UA.chromeWindows, userAgentData: { brands: [] } })).toBeNull();
  });

  it('returns null when the browser refuses', async () => {
    const getHighEntropyValues = vi.fn().mockRejectedValue(new DOMException('blocked', 'NotAllowedError'));
    expect(await readHighEntropy({ userAgent: UA.chromeWindows, userAgentData: { getHighEntropyValues } })).toBeNull();
  });
});

describe('watchEnvironmentLine', () => {
  it('reports a line at once and refines it when the high entropy values arrive', async () => {
    vi.resetModules();
    const getHighEntropyValues = vi.fn().mockResolvedValue({ platformVersion: '14.0.0', model: 'Pixel 8', architecture: '', bitness: '64' });
    vi.stubGlobal('navigator', {
      userAgent: UA.chromeAndroidReduced,
      userAgentData: { brands: BRANDS.chrome, mobile: true, platform: 'Android', getHighEntropyValues },
      hardwareConcurrency: 8,
    });
    const { watchEnvironmentLine, collectEnvironment: collect } = await import('../../demo/src/ui/deviceInfo.ts');
    const lines: string[] = [];
    watchEnvironmentLine((l) => lines.push(l));
    expect(lines).toEqual(['Chrome 155 on Android, 8 threads']);
    await vi.waitFor(() => expect(lines).toHaveLength(2));
    expect(lines[1]).toBe('Chrome 155 on Android 14 (Pixel 8), 8 threads');
    expect(collect().userAgentData?.model).toBe('Pixel 8');
  });

  it('reports a single line when the browser has no userAgentData', async () => {
    vi.resetModules();
    vi.stubGlobal('navigator', { userAgent: UA.safariIphone, hardwareConcurrency: 6 });
    const { watchEnvironmentLine } = await import('../../demo/src/ui/deviceInfo.ts');
    const lines: string[] = [];
    watchEnvironmentLine((l) => lines.push(l));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lines).toEqual(['Safari 18.1 on iOS 18.1, 6 threads']);
  });
});

function result(name: string): FileResult {
  return { fileName: name, container: 'mp4' } as unknown as FileResult;
}

describe('buildExport', () => {
  const env = collectEnvironment(fake(UA.chromeWindows, { hardwareConcurrency: 16 }), NOW);

  it('names the build by the hashed entry chunk of the page', () => {
    vi.stubGlobal('document', { querySelector: () => ({ src: 'https://example.test/video-fps-probe/assets/index-CxCQjnzz.js?v=1' }) });
    try {
      expect(entryChunk()).toBe('index-CxCQjnzz.js');
    } finally {
      vi.unstubAllGlobals();
    }
    expect(entryChunk()).toBeNull();
  });

  it('wraps the results with schema, app, environment and settings in that order', () => {
    const doc = buildExport([{ result: result('a.mp4'), compare: {} }], { matroskaMode: 'probe' }, env);
    expect(Object.keys(doc)).toEqual(['schema', 'app', 'environment', 'settings', 'results']);
    expect(doc.schema).toBe(EXPORT_SCHEMA);
    expect(doc.app).toEqual({ name: 'video-fps-probe', version, build: null, buildTime: null, commit: null });
    expect(doc.environment).toBe(env);
    expect(doc.settings).toEqual({ matroskaMode: 'probe' });
    expect(doc.results).toEqual([result('a.mp4')]);
  });

  it('keeps the own result untouched and nests finished comparison runs under compare', () => {
    const own = result('a.mp4');
    const rows: ExportRow[] = [
      { result: own, compare: { mp4box: { result: result('mp4box') }, mediabunny: { result: result('mediabunny') }, rvfc: { result: null }, other: undefined } },
    ];
    const [out] = buildExport(rows, { matroskaMode: 'auto' }, env).results;
    expect(out).toEqual({ ...own, compare: { mp4box: result('mp4box'), mediabunny: result('mediabunny') } });
    expect(own).not.toHaveProperty('compare');
  });

  it('leaves out rows without a result and omits compare when no run finished', () => {
    const rows: ExportRow[] = [
      { result: null, compare: { mp4box: { result: result('x') } } },
      { result: result('b.mkv'), compare: { rvfc: { result: null } } },
    ];
    const doc = buildExport(rows, { matroskaMode: 'auto' }, env);
    expect(doc.results).toHaveLength(1);
    expect(doc.results[0]).not.toHaveProperty('compare');
  });

  it('produces an empty results array for an empty list and survives a JSON round trip', () => {
    const doc = buildExport([], { matroskaMode: 'auto' }, env);
    expect(doc.results).toEqual([]);
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });
});

describe('exportResults', () => {
  const rows: ExportRow[] = [{ result: result('a.mp4'), compare: {} }, { result: result('b.mkv'), compare: {} }];
  const settings = { matroskaMode: 'exact' } as const;

  it('copies the JSON through the async clipboard, starting the write before the first await', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { userAgent: UA.safariIphone, clipboard: { writeText } });
    const pending = exportResults(rows, settings, 'copy');
    expect(writeText).toHaveBeenCalledTimes(1);
    const outcome = await pending;
    expect(outcome).toEqual({ ok: true, message: 'Copied 2 results to the clipboard.', text: null });
    const copied = JSON.parse(writeText.mock.calls[0]![0] as string);
    expect(copied.schema).toBe(EXPORT_SCHEMA);
    expect(copied.settings).toEqual({ matroskaMode: 'exact' });
    expect(copied.results).toHaveLength(2);
    expect(copied.environment.userAgent).toBe(UA.safariIphone);
  });

  it('uses the singular for one result', async () => {
    vi.stubGlobal('navigator', { userAgent: UA.safariIphone, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    expect((await exportResults(rows.slice(0, 1), settings, 'copy')).message).toBe('Copied 1 result to the clipboard.');
  });

  function stubDocument(copyCommand: () => boolean) {
    const area = { style: { cssText: '' }, value: '', readOnly: false, select: vi.fn(), setSelectionRange: vi.fn(), remove: vi.fn() };
    const append = vi.fn();
    vi.stubGlobal('document', {
      createElement: vi.fn(() => area),
      body: { append },
      execCommand: vi.fn((command: string) => command === 'copy' && copyCommand()),
    });
    return { area, append };
  }

  it('falls back to selection copy when the async clipboard is missing', async () => {
    vi.stubGlobal('navigator', { userAgent: UA.safariIphone });
    const { area, append } = stubDocument(() => true);
    const outcome = await exportResults(rows, settings, 'copy');
    expect(outcome.ok).toBe(true);
    expect(area.value).toContain(EXPORT_SCHEMA);
    expect(area.select).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(area);
    expect(area.remove).toHaveBeenCalledTimes(1);
  });

  it('falls back to selection copy when the async clipboard rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    vi.stubGlobal('navigator', { userAgent: UA.safariIphone, clipboard: { writeText } });
    stubDocument(() => true);
    expect((await exportResults(rows, settings, 'copy')).ok).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('hands the text back with a message when every copy path is blocked', async () => {
    vi.stubGlobal('navigator', { userAgent: UA.safariIphone });
    const { area } = stubDocument(() => false);
    const outcome = await exportResults(rows, settings, 'copy');
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('blocked copying');
    expect(JSON.parse(outcome.text!).results).toHaveLength(2);
    expect(area.remove).toHaveBeenCalledTimes(1);
  });

  it('treats a throwing execCommand as a blocked copy', async () => {
    vi.stubGlobal('navigator', { userAgent: UA.safariIphone });
    const { area } = stubDocument(() => false);
    (document.execCommand as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('unsupported');
    });
    const outcome = await exportResults(rows, settings, 'copy');
    expect(outcome.ok).toBe(false);
    expect(area.remove).toHaveBeenCalledTimes(1);
  });

  it('downloads a JSON file through a temporary object URL', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { userAgent: UA.safariIphone });
    const anchor = { href: '', download: '', click: vi.fn() };
    vi.stubGlobal('document', { createElement: vi.fn(() => anchor) });
    let saved: Blob | null = null;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      saved = blob as Blob;
      return 'blob:fake';
    });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const outcome = await exportResults(rows, settings, 'download');
    expect(outcome).toEqual({ ok: true, message: `Saved 2 results as ${EXPORT_FILE_NAME}.`, text: null });
    expect(anchor).toMatchObject({ href: 'blob:fake', download: EXPORT_FILE_NAME });
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revoke).toHaveBeenCalledWith('blob:fake');
    vi.useRealTimers();
    const blob = saved as Blob | null;
    expect(blob?.type).toBe('application/json');
    expect(JSON.parse(await blob!.text()).schema).toBe(EXPORT_SCHEMA);
  });
});
