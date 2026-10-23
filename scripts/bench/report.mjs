import { fmtBytes, fmtFps, fmtMs, fmtPct, geomean, median } from './values.mjs';

const cell = (s) => String(s ?? '-').replace(/\|/g, '\\|');

function table(head, align, rows) {
  return [
    `| ${head.join(' | ')} |`,
    `|${align.split('').map((a) => (a === 'r' ? '---:' : '---')).join('|')}|`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

const sum = (xs) => xs.reduce((s, x) => s + (x ?? 0), 0);
const kb = (n) => `${(n / 1000).toFixed(1)} KB`;

function pctile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
}

function environment(d) {
  const e = d.environment ?? {};
  const c = e.chrome ?? {};
  const hz = e.displayHzOs ? `${e.displayHzOs.join(', ')} Hz (Windows, Win32_VideoController)` : 'not reported by the OS query';
  const rows = [
    ['Browser', `${c.product ?? '-'} (V8 ${c.jsVersion ?? '-'}), headless=new`],
    ['Second browser', e.edge ? `${e.edge.product} (V8 ${e.edge.jsVersion}), headless=new, warm own-engine run only` : 'Edge not installed or skipped'],
    ['OS', e.os],
    ['CPU', `${e.cpu}, ${e.logicalCores} logical cores`],
    ['Memory', `${e.memoryGiB} GiB`],
    ['GPU (Chrome)', c.gpu ? `${c.gpu.device ?? '-'}; video decode: ${c.gpu.videoDecode ?? '-'}; compositing: ${c.gpu.gpuCompositing ?? '-'}` : '-'],
    ['Display', `physical display ${hz}; requestAnimationFrame in the headless page ${c.rafHz ? c.rafHz.toFixed(1) : '-'} Hz (idle page)`],
    ['Timer', `performance.now() step ${c.timerResolutionMs ? fmtMs(c.timerResolutionMs) : '-'} ms in the page (the app is not cross-origin isolated, so Chrome coarsens the clock; worker timings share that granularity)`],
    ['Node', e.node],
    ['Date', e.date],
    ['Run time', `${d.totalSeconds?.toFixed(0) ?? '-'} s`],
  ];
  return table(['', ''], 'll', rows);
}

function warmRows(d) {
  const warm = d.chrome.warm ?? {};
  const edge = d.edge?.warm ?? null;
  return d.fixtures
    .filter((f) => warm[f.name])
    .map((f) => {
      const w = warm[f.name];
      const row = [
        f.name,
        w.container,
        fmtBytes(w.size),
        fmtMs(w.medianMs),
        fmtMs(w.minMs),
        fmtMs(w.medianWallMs),
        fmtMs(d.chrome.coldBatch?.perFile?.[f.name]?.ms),
        w.reads,
        fmtBytes(w.bytesRead),
        fmtPct(w.bytesRead, w.size),
      ];
      if (edge) row.push(fmtMs(edge[f.name]?.medianMs));
      return row;
    });
}

function keyNumbers(d) {
  const out = [];
  const warm = Object.values(d.chrome.warm ?? {});
  if (warm.length) {
    const meds = warm.map((w) => w.medianMs);
    const worst = Object.entries(d.chrome.warm).sort((a, b) => b[1].medianMs - a[1].medianMs)[0];
    const size = sum(warm.map((w) => w.size));
    const read = sum(warm.map((w) => w.bytesRead));
    out.push(
      `Own engine, warm, Chrome: per-fixture median **${fmtMs(median(meds))} ms** (p90 ${fmtMs(pctile(meds, 90))} ms, slowest ${fmtMs(worst[1].medianMs)} ms for \`${worst[0]}\`); UI time from file pick to rendered result median ${fmtMs(median(warm.map((w) => w.medianWallMs)))} ms.`,
    );
    out.push(
      `I/O: median ${median(warm.map((w) => w.reads))} reads per file (max ${Math.max(...warm.map((w) => w.reads))}); ${fmtBytes(read)} read of ${fmtBytes(size)} in total (${fmtPct(read, size)}%), median ${fmtPct(median(warm.filter((w) => w.size > 0).map((w) => w.bytesRead / w.size)), 1)}% of a file.`,
    );
  }
  const cb = d.chrome.coldBatch;
  const rb = d.chrome.reloadBatch;
  if (cb) {
    out.push(
      `Cold batch: ${cb.files} files picked at once on a fresh profile: all results rendered after **${fmtMs(cb.wallMs)} ms** (worker time summed over files ${fmtMs(cb.sumMs)} ms, two workers)${rb ? `; the same batch on a reloaded page took ${fmtMs(rb.medianMs)} ms (median of ${rb.wallMs.length}, range ${fmtMs(rb.minMs)}-${fmtMs(rb.maxMs)} ms)` : ''}.`,
    );
  }
  for (const c of d.chrome.coldFirst ?? []) {
    const steady = d.chrome.warm?.[c.name]?.medianWallMs ?? c.warmWallMs;
    out.push(
      `Cold first ${c.label} file (\`${c.name}\`): **${fmtMs(c.coldWallMs)} ms** from pick to rendered result on a freshly loaded page, against ${fmtMs(steady)} ms once warm, so the first file of that container costs about ${fmtMs(c.coldWallMs - steady)} ms extra (worker start, worker entry and parser chunk fetch and compile, first unoptimised run).`,
    );
  }
  const eng = d.chrome.engines;
  if (eng) {
    for (const engine of ['mp4box', 'mediabunny']) {
      const rows = Object.entries(eng).filter(([, v]) => v[engine]);
      if (!rows.length) continue;
      const same = rows.filter(([, v]) => v[engine].agreement === 'same').length;
      const own = rows.map(([n]) => d.chrome.warm?.[n]?.medianMs).filter(Number.isFinite);
      const ratio = geomean(rows.map(([n, v]) => (d.chrome.warm?.[n]?.medianMs ? v[engine].medianMs / d.chrome.warm[n].medianMs : null)));
      out.push(
        `${engine}: ${rows.length} fixtures, median ${fmtMs(median(rows.map(([, v]) => v[engine].medianMs)))} ms per file${own.length && ratio ? ` (geometric mean ${ratio.toFixed(1)}x the own engine)` : ''}; same average and frame count as the own engine on ${same} of ${rows.length}.`,
      );
    }
  }
  const rv = d.chrome.rvfc?.rows;
  if (rv?.length) {
    const ok = rv.filter((r) => !r.error);
    const exact = ok.filter((r) => r.errorPct !== null && Math.abs(r.errorPct) < 1e-6).length;
    out.push(
      `rVFC: ${ok.length} of ${rv.length} files produced an estimate (${exact} equal to ffprobe's average); ${ok.length ? `${fmtMs(median(ok.map((r) => r.ms)) / 1000)} s median, ${fmtMs(Math.max(...ok.map((r) => r.ms)) / 1000)} s max per file` : ''}.`,
    );
  }
  if (d.sanity) out.push(`Chrome vs Node (same own engine): ${d.sanity.identical} of ${d.sanity.compared} results identical (all fields except timing).`);
  if (d.edge?.warm && d.chrome.warm) {
    const r = geomean(Object.entries(d.edge.warm).map(([n, v]) => (d.chrome.warm[n] ? v.medianMs / d.chrome.warm[n].medianMs : null)));
    out.push(`Edge, warm own engine: per-fixture median ${fmtMs(median(Object.values(d.edge.warm).map((w) => w.medianMs)))} ms; geometric mean ${r ? r.toFixed(2) : '-'}x Chrome.`);
  }
  return out.map((s) => `- ${s}`).join('\n');
}

function coldSection(d) {
  const parts = ['## Cold start'];
  const pl = d.chrome.pageLoad;
  if (pl) {
    const res = pl.requests.filter((r) => r.status === 200);
    parts.push(
      `Fresh profile, empty cache, server sends \`no-store\`. Page: DOMContentLoaded at ${fmtMs(pl.domContentLoadedMs)} ms, load at ${fmtMs(pl.loadMs)} ms, app ready (test hook and file input present) at ${fmtMs(pl.readyMs)} ms after navigation start. Requests: ${res.map((r) => `\`${r.path}\` ${kb(r.bytes)}`).join(', ')} (uncompressed bytes; gzip sizes are in report/size.md).`,
    );
  }
  const cb = d.chrome.coldBatch;
  if (cb) {
    const chunks = new Map();
    for (const r of cb.requests) {
      const c = chunks.get(r.path) ?? { n: 0, bytes: r.bytes };
      c.n++;
      chunks.set(r.path, c);
    }
    parts.push(
      `### First batch\n\nAll ${cb.files} committed fixtures picked at once right after the first load: **${fmtMs(cb.wallMs)} ms** until every result was rendered; worker time summed over files ${fmtMs(cb.sumMs)} ms. The pool has two workers, so each fetches the worker entry and the parser chunks it needs once.${d.chrome.reloadBatch ? ` The first load is a single sample; the same batch on a reloaded page (new workers, chunks fetched again) took ${d.chrome.reloadBatch.wallMs.map(fmtMs).join(', ')} ms in ${d.chrome.reloadBatch.wallMs.length} reloads (median ${fmtMs(d.chrome.reloadBatch.medianMs)} ms).` : ''}\n\n` +
        table(
          ['Chunk fetched during the batch', 'Requests', 'Bytes'],
          'lrr',
          [...chunks].map(([p, c]) => [`\`${p}\``, c.n, kb(c.bytes)]),
        ),
    );
  }
  if (d.chrome.coldFirst?.length) {
    parts.push(
      `### Cold first-file cost\n\nOne file picked on a freshly loaded page (no worker yet), then the same file a second time on that page; median of ${d.options.coldReps} page loads. "Steady" is the warm median from the table below (many earlier runs, optimised code). Extra = cold minus steady: spawning the worker, fetching and compiling the worker entry and the parser chunk, and running unoptimised code for the first time. Over localhost the network part is close to zero; on a real connection add one round trip for the worker entry and one for the parser chunk (their gzip sizes are in report/size.md).\n\n` +
        table(
          ['Container', 'File', 'Cold UI ms', '2nd pick UI ms', 'Steady UI ms', 'Extra ms', 'Cold worker ms', '2nd pick worker ms', 'Steady worker ms', 'Chunks fetched for the first file'],
          'llrrrrrrrl',
          d.chrome.coldFirst.map((c) => {
            const w = d.chrome.warm?.[c.name];
            return [
              c.label,
              `\`${c.name}\``,
              fmtMs(c.coldWallMs),
              fmtMs(c.warmWallMs),
              fmtMs(w?.medianWallMs),
              fmtMs(c.coldWallMs - (w?.medianWallMs ?? c.warmWallMs)),
              fmtMs(c.coldMs),
              fmtMs(c.warmMs),
              fmtMs(w?.medianMs),
              c.chunks.map((x) => `${x.path.replace('/assets/', '')} (${kb(x.bytes)})`).join(', '),
            ];
          }),
        ),
    );
  }
  return parts.join('\n\n');
}

function warmSection(d) {
  if (!d.chrome.warm) return '';
  const edge = !!d.edge?.warm;
  const head = ['Fixture', 'Container', 'Size', 'ms (median)', 'ms (min)', 'UI ms (median)', 'ms in cold batch', 'Reads', 'Bytes read', '% of file'];
  if (edge) head.push('Edge ms (median)');
  const rows = warmRows(d);
  const w = Object.values(d.chrome.warm);
  const total = ['**total**', '', fmtBytes(sum(w.map((x) => x.size))), fmtMs(sum(w.map((x) => x.medianMs))), fmtMs(sum(w.map((x) => x.minMs))), fmtMs(sum(w.map((x) => x.medianWallMs))), fmtMs(d.chrome.coldBatch?.sumMs), sum(w.map((x) => x.reads)), fmtBytes(sum(w.map((x) => x.bytesRead))), fmtPct(sum(w.map((x) => x.bytesRead)), sum(w.map((x) => x.size)))];
  if (edge) total.push(fmtMs(sum(Object.values(d.edge.warm).map((x) => x.medianMs))));
  rows.push(total);
  const notes = [];
  if (d.sanity?.warmNotRepeatable?.length) notes.push(`Results changed between repetitions for: ${d.sanity.warmNotRepeatable.join(', ')}.`);
  else if (d.sanity) notes.push('Every repetition returned the same result (all fields except timing), and it equals the cold-batch result.');
  return [
    `## Own engine, warm${edge ? ' (Chrome, with Edge for comparison)' : ''}`,
    `Each fixture picked alone, ${d.options.reps} times, list cleared between runs, after the cold batch had loaded both parser chunks. \`ms\` is the worker-side \`FileResult.io.ms\`; \`UI ms\` adds the worker round trip and the React render; \`ms in cold batch\` is the same file's worker time inside the first ${d.chrome.coldBatch?.files ?? 0}-file batch (first files per worker include the parser chunk load, later ones run concurrently on two workers). Reads and bytes are the unique reads through the shared reader.${notes.length ? ` ${notes.join(' ')}` : ''}`,
    table(head, `llr${'r'.repeat(head.length - 3)}`, rows),
  ].join('\n\n');
}

function enginesSection(d) {
  const eng = d.chrome.engines;
  if (!eng) return '';
  const rows = d.fixtures
    .filter((f) => eng[f.name] && (eng[f.name].mp4box || eng[f.name].mediabunny))
    .map((f) => {
      const e = eng[f.name];
      const w = d.chrome.warm?.[f.name];
      const m = e.mp4box;
      const b = e.mediabunny;
      return [
        f.name,
        w?.container ?? '-',
        fmtMs(w?.medianMs),
        m ? fmtMs(m.medianMs) : 'n/a',
        b ? fmtMs(b.medianMs) : 'n/a',
        w ? `${fmtBytes(w.bytesRead)} (${w.reads})` : '-',
        m ? `${fmtBytes(m.bytesRead)} (${m.reads ?? '-'})` : 'n/a',
        b ? `${fmtBytes(b.bytesRead)} (${b.reads ?? '-'})` : 'n/a',
        m ? (m.error ? `error: ${m.error}` : m.agreement) : 'n/a',
        b ? (b.error ? `error: ${b.error}` : b.agreement) : 'n/a',
      ];
    });
  return [
    '## Engine comparison (Chrome)',
    `mp4box and mediabunny run through \`window.__fpsProbe.runEngine\` on every fixture they support (mp4box: MP4 and MOV; mediabunny: MP4, MOV, WebM and Matroska), ${d.options.engineReps} runs each, median shown. Their libraries are lazy chunks loaded by the worker on first use. \`ms\` is each engine's own \`io.ms\`; the own column repeats the warm median. "same" means the same average frame rate (exact rational or within 1e-9) and the same frame count as the own engine; accuracy against ffprobe is in report/accuracy.md.`,
    table(
      ['Fixture', 'Container', 'own ms', 'mp4box ms', 'mediabunny ms', 'own bytes (reads)', 'mp4box bytes (reads)', 'mediabunny bytes (reads)', 'mp4box vs own', 'mediabunny vs own'],
      'llrrrrrrll',
      rows,
    ),
  ].join('\n\n');
}

function largeSection(d) {
  const large = d.chrome.large;
  if (!large || !Object.keys(large).length) return '';
  const rows = [];
  for (const [name, v] of Object.entries(large)) {
    const size = v.own.size;
    for (const engine of ['own', 'mp4box', 'mediabunny']) {
      const x = v[engine];
      if (!x) continue;
      const s = x.summary;
      rows.push([
        name,
        fmtBytes(size),
        engine,
        fmtMs(x.medianMs),
        fmtMs(x.medianWallMs),
        x.reads ?? '-',
        fmtBytes(x.bytesRead),
        fmtPct(x.bytesRead, size),
        s?.avg ?? (x.error ? `error: ${x.error}` : '-'),
        s?.frames ?? '-',
        engine === 'own' ? '' : x.agreement,
      ]);
    }
  }
  return [
    '## Large files',
    `Local-only fixtures from fixtures/large (not committed, generated by the fixture scripts), each engine ${d.options.engineReps} runs, median shown. \`ms\` is the engine's own \`io.ms\` inside the worker; \`UI ms\` is the page-side round trip (own engine: file pick to rendered result; mp4box and mediabunny: \`runEngine\` call to resolved promise, which includes posting the result back).`,
    table(['File', 'Size', 'Engine', 'ms', 'UI ms', 'Reads', 'Bytes read', '% of file', 'Average', 'Frames', 'vs own'], 'llrrrrrrlrl', rows),
    ...nativeNote(large),
  ].join('\n\n');
}

function nativeNote(large) {
  const parts = Object.entries(large)
    .filter(([, v]) => Number.isFinite(v.mediabunny?.nativeStatsMs))
    .map(([name, v]) => (v.mediabunny.nativeSkipped ? `skipped for \`${name}\` (too many packets, the engine applies the same formula itself)` : `${fmtMs(v.mediabunny.nativeStatsMs)} ms for \`${name}\``));
  return parts.length
    ? [`mediabunny's \`io.ms\` stops before its own packet statistics call (\`computePacketStats\`, timed separately as \`nativeStatsMs\`: ${parts.join(', ')}); that time is included in UI ms but not in ms.`]
    : [];
}

function rvfcSection(d) {
  const rv = d.chrome.rvfc;
  if (!rv) return '';
  const cbs = sum(rv.rows.map((r) => r.callbacks));
  const hzs = rv.rows.map((r) => r.displayHz).filter((x) => Number.isFinite(x) && x > 0);
  const hz = hzs.length ? [`median ${median(hzs).toFixed(1)}`, `range ${Math.min(...hzs).toFixed(1)}-${Math.max(...hzs).toFixed(1)}`] : [];
  const rows = rv.rows.map((r) => [
    r.name,
    r.ref ? `${r.ref} (${fmtFps(r.refValue)})` : '-',
    r.error ? `error: ${r.error}` : `${r.estimate} (${fmtFps(r.value)})`,
    r.errorPct === null ? '-' : `${r.errorPct > 0 ? '+' : ''}${r.errorPct.toFixed(3)}%`,
    `${r.refVfr === null ? '-' : r.refVfr ? 'yes' : 'no'} / ${r.isVfr === null ? '-' : r.isVfr ? 'yes' : 'no'}`,
    r.confidence ?? '-',
    r.flags.length ? r.flags.join(', ') : '-',
    r.passes.length ? `${r.passes.length} (x${r.rate})` : '-',
    r.callbacks,
    r.ms === null ? '-' : (r.ms / 1000).toFixed(2),
    r.displayHz ? r.displayHz.toFixed(1) : '-',
  ]);
  return [
    '## rVFC (playback estimate)',
    `Mode: ${rv.mode}. requestVideoFrameCallback fired ${cbs} times in total, so headless playback does present frames. The engine measured a refresh of ${hz.join(', ') || '-'} Hz with requestAnimationFrame${d.environment?.displayHzOs ? ` (the OS reports ${d.environment.displayHzOs.join(', ')} Hz for the physical display)` : ''}. One run per file. Error is the rVFC average against ffprobe's \`avg_frame_rate\`; the VFR column is ffprobe packet timing / rVFC. An error row means the browser could not play the file, which is what the fallback reports to the user.`,
    table(['File', 'ffprobe avg', 'rVFC estimate', 'Error', 'VFR (ref / rVFC)', 'Confidence', 'Flags', 'Passes (last rate)', 'Callbacks', 'Time s', 'Display Hz'], 'llllllllrrr', rows),
  ].join('\n\n');
}

function sanitySection(d) {
  const s = d.sanity;
  if (!s) return '';
  const lines = [
    '## Chrome vs Node',
    `The own engine's results in Chrome (cold batch, and the large files) compared field by field with \`analyze()\` run in Node ${d.environment?.node ?? ''} on the same files (\`fs.openAsBlob\`), ignoring only \`io.ms\`. Compared: ${s.compared}; identical: **${s.identical}**; equal average rational, frames, min, max and VFR flag: ${s.keyFieldsEqual}.`,
  ];
  if (s.differences.length) {
    lines.push(table(['File', 'Key fields that differ', 'First differences'], 'lll', s.differences.map((x) => [x.name, x.keyFieldDiffs.join(', ') || 'none', x.diffs.slice(0, 3).join('; ')])));
  } else {
    lines.push('No differences.');
  }
  if (s.warmDiffersFromCold?.length) lines.push(`Warm results that differ from the cold batch: ${s.warmDiffersFromCold.join(', ')}.`);
  return lines.join('\n\n');
}

function shotsSection(d) {
  if (!d.screenshots?.length) return '';
  return [
    '## Screenshots',
    table(['File', 'Size', 'Pixels', 'Content'], 'lrrl', d.screenshots.map((s) => [`docs/screenshots/${s.file}`, `${(s.bytes / 1024).toFixed(0)} KiB`, `${s.width}x${s.height}`, s.note])),
  ].join('\n\n');
}

export function renderMarkdown(d) {
  const intro = `Generated by \`npm run bench\` (\`scripts/bench/run-bench.mjs\`). The built app in \`demo/dist/\` is served by a local \`node:http\` server (127.0.0.1, \`Cache-Control: no-store\`, no compression) and driven over the Chrome DevTools Protocol in headless Chrome with a throwaway profile. Files go through the real file input (\`DOM.setFileInputFiles\` with absolute paths), so every \`File\` is disk-backed, as when a user picks files. Times are wall-clock milliseconds on the machine below; \`ms\` is the analysis inside the worker (\`FileResult.io.ms\`, from the start of \`analyze()\` to the result, including any lazy parser chunk load), \`UI ms\` is measured in the page from the input's \`change\` event to the DOM update that shows the last result. Every number comes from one run of the bench on one desktop; with a 0.1 ms clock and other processes on the machine, differences of a few tenths of a millisecond between engines or browsers are noise.`;
  const sections = [
    '# Browser benchmark',
    intro,
    '## Environment',
    environment(d),
    '## Key numbers',
    keyNumbers(d),
    coldSection(d),
    warmSection(d),
    enginesSection(d),
    largeSection(d),
    rvfcSection(d),
    sanitySection(d),
    shotsSection(d),
    `## Reproduce\n\n\`\`\`\nnpm run build\nnpm run bench\n\`\`\`\n\nOptions: \`--reps\`, \`--engine-reps\`, \`--cold-reps\`, \`--filter <text>\` (writes \`browser-bench.local.*\`), \`--skip warm,engines,large,cold-first,rvfc,edge,node,shots\`, \`--no-write\`. Chrome is taken from \`CHROME_PATH\` or the standard install location; Edge is used when installed. Command of this run: \`${d.command}\`.`,
  ];
  return `${sections.filter(Boolean).join('\n\n')}\n`;
}
