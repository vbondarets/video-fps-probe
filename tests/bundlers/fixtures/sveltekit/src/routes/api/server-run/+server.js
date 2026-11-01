import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { json } from '@sveltejs/kit';
import * as root from 'video-fps-probe';
import * as aspect from 'video-fps-probe/aspect';
import * as check from 'video-fps-probe/check';
import * as color from 'video-fps-probe/color';
import * as header from 'video-fps-probe/header';
import * as presets from 'video-fps-probe/presets';
import * as url from 'video-fps-probe/url';
import { serverRun } from '../../../../server-run-core.mjs';

export async function GET({ url: request }) {
  const name = request.searchParams.get('file');
  const bytes = new Uint8Array(await readFile(join(process.env.BUNDLERS_FILES_DIR, name)));
  return json({ loader: 'framework', run: await serverRun({ root, header, url, color, aspect, check, presets }, bytes, name) });
}
