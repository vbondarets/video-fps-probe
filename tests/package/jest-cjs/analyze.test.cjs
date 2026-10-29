const { openAsBlob, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { analyze } = require('video-fps-probe');
const { check } = require('video-fps-probe/check');
const { klingO1ReferenceVideo } = require('video-fps-probe/presets');

const FIXTURE = join(__dirname, '..', '..', '..', 'fixtures', 'files', 'cfr_h264_30.mp4');

test('analyze and check run under Jest from CommonJS', async () => {
  const result = await analyze(await openAsBlob(FIXTURE), { name: 'cfr_h264_30.mp4' });
  const report = check(result, klingO1ReferenceVideo.rules);
  expect(result.error).toBeNull();
  expect(result.videoTracks[0]).toMatchObject({ avgFps: { num: 30, den: 1 }, frames: 90 });
  expect(report.verdict).toBe('fail');
  if (process.env.JEST_CJS_OUT) writeFileSync(process.env.JEST_CJS_OUT, JSON.stringify({ result: { ...result, io: null }, report }));
});
