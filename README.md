# Video FPS Probe

Proof of concept that computes the frame rate of video files picked or dropped
in the browser. Everything runs client-side in a Web Worker: only the bytes
needed are read with `Blob.slice`, nothing is decoded and nothing is uploaded.

Results are validated against ffprobe 8.1.1, including variable frame rate.
The approved design and measurements are in [docs/research.md](docs/research.md).

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Type-check and build to `dist/` |
| `npm run typecheck` | `tsc -b` for app, config and test projects |
| `npm run lint` | Run oxlint |
| `npm test` | Run the Vitest suite |
| `npm run fixtures:generate` | Generate the fixture videos (needs ffmpeg) |
| `npm run fixtures:refs` | Extract ffprobe reference data for the fixtures |
| `npm run compare` | Compare probe results with ffprobe references |
| `npm run size` | Report bundle size (raw and gzip) |
| `npm run bench` | Run the read and timing benchmark |

## Requirements

Node 22.12 or newer, npm, and ffmpeg/ffprobe 8.1.1 on PATH for the fixture scripts.

## License

MIT
