import { analyzeHeader } from 'video-fps-probe/header';
import { RangeSourceError, httpRange, openRangeSource, rangeSource, readCapped } from 'video-fps-probe/url';

declare global {
  interface Window {
    __header?: { analyzeHeader: typeof analyzeHeader };
    __url?: { analyzeHeader: typeof analyzeHeader; RangeSourceError: typeof RangeSourceError; httpRange: typeof httpRange; openRangeSource: typeof openRangeSource; rangeSource: typeof rangeSource; readCapped: typeof readCapped };
  }
}

const overRange: typeof analyzeHeader = (input, options) => {
  const blob = input as Blob;
  const source = rangeSource(
    async ({ start, end, signal }) => ({
      status: 206,
      contentRange: `bytes ${start}-${end - 1}/${blob.size}`,
      contentLength: end - start,
      body: (expectedLength) => readCapped(blob.slice(start, end).stream(), expectedLength, signal),
    }),
    { size: blob.size },
  );
  return analyzeHeader(source, options);
};

window.__header = { analyzeHeader: overRange };
window.__url = { analyzeHeader, RangeSourceError, httpRange, openRangeSource, rangeSource, readCapped };
