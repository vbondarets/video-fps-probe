const withoutMs = (r) => ({ ...r, io: { ...r.io, ms: 0 } });

export async function serverRun({ root, header, url, color, aspect, check, presets }, bytes, name) {
  const blob = new Blob([bytes]);
  const result = await root.analyze(blob, { name });
  const head = await header.analyzeHeader(blob, { name });
  const metadata = await header.analyzeHeader(blob, { name, color: true, aspect: true });
  const raw = await header.analyzeHeader(blob, { name, codecConfig: true });
  let calls = 0;
  const source = url.rangeSource(
    async ({ start, end }) => {
      calls++;
      return { status: 206, contentRange: `bytes ${start}-${end - 1}/${bytes.byteLength}`, bytes: bytes.subarray(start, end) };
    },
    { size: bytes.byteLength },
  );
  const ranged = await header.analyzeHeader(source, { name });
  const refused = await url
    .rangeSource(async () => ({ status: 200, bytes: bytes.subarray(0, 10) }), { size: bytes.byteLength })
    .read(0, 10)
    .catch((e) => e);
  return JSON.parse(
    JSON.stringify({
      result: { ...result, io: { reads: result.io.reads, bytesRead: result.io.bytesRead } },
      header: withoutMs(head),
      metadata: withoutMs(metadata),
      metadataByEntry: withoutMs(aspect.withAspect(color.withColor(raw))),
      ranged: withoutMs(ranged),
      calls,
      report: check.check(result, presets.klingO1ReferenceVideo.rules),
      refused: { name: refused.name, code: refused.code, status: refused.status, instance: refused instanceof url.RangeSourceError },
      guards: [root.isAbortError({ name: 'AbortError' }), header.isTimeoutError({ name: 'TimeoutError' }), header.errorClass('time-limit')],
    }),
  );
}

export const SERVER_ENTRIES = {
  root: 'video-fps-probe',
  header: 'video-fps-probe/header',
  url: 'video-fps-probe/url',
  color: 'video-fps-probe/color',
  aspect: 'video-fps-probe/aspect',
  check: 'video-fps-probe/check',
  presets: 'video-fps-probe/presets',
};
