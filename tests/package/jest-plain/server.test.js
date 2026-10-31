'use strict';
const { openAsBlob, writeFileSync } = require('node:fs');

const ENTRIES = ['video-fps-probe', 'video-fps-probe/header', 'video-fps-probe/url', 'video-fps-probe/check', 'video-fps-probe/presets'];
const withoutMs = (r) => ({ ...r, io: { ...r.io, ms: 0 } });

test('the server entries load with no configuration and analyze an MP4 in full, header and Range mode', async () => {
  const { analyze, isAbortError } = require('video-fps-probe');
  const { analyzeHeader, errorClass, isTimeoutError } = require('video-fps-probe/header');
  const { rangeSource, RangeSourceError } = require('video-fps-probe/url');
  const { check } = require('video-fps-probe/check');
  const { klingO1ReferenceVideo } = require('video-fps-probe/presets');
  const name = 'cfr_h264_30.mp4';
  const blob = await openAsBlob(process.env.JEST_FIXTURE);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const result = await analyze(blob, { name });
  const header = await analyzeHeader(blob, { name });
  let calls = 0;
  const source = rangeSource(
    async ({ start, end }) => {
      calls++;
      return { status: 206, contentRange: `bytes ${start}-${end - 1}/${bytes.byteLength}`, bytes: bytes.subarray(start, end) };
    },
    { size: bytes.byteLength },
  );
  const ranged = await analyzeHeader(source, { name });
  const refused = await rangeSource(async () => ({ status: 200, bytes: bytes.subarray(0, 10) }), { size: bytes.byteLength })
    .read(0, 10)
    .catch((e) => e);
  writeFileSync(
    process.env.JEST_OUT,
    JSON.stringify({
      resolved: ENTRIES.map((e) => require.resolve(e)),
      result: { ...result, io: null },
      header: withoutMs(header),
      ranged: withoutMs(ranged),
      calls,
      report: check(result, klingO1ReferenceVideo.rules),
      refused: { name: refused.name, code: refused.code, status: refused.status, instance: refused instanceof RangeSourceError },
      guards: [isAbortError({ name: 'AbortError' }), isTimeoutError({ name: 'TimeoutError' }), errorClass('time-limit')],
    }),
  );
  expect(ranged.io.reads).toBe(calls);
  expect(result.videoTracks[0].avgFps).toEqual({ num: 30, den: 1, value: 30 });
});
