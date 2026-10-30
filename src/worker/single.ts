import { analyzeWith } from '../core/dispatch.ts';
import { withErrorCode } from '../core/reader.ts';
import type { ContainerAnalyzer } from '../core/types.ts';
import type { ContainerFamily, EngineModule } from '../plugins/types.ts';

const LABEL: Readonly<Record<ContainerFamily, string>> = { isobmff: 'ISO BMFF', matroska: 'Matroska' };

export const wrongFamily = (served: ContainerFamily, found: ContainerFamily): string => `the own ${LABEL[served]} worker does not read ${LABEL[found]}`;

export function singleContainerEngine(kind: ContainerFamily, analyzer: ContainerAnalyzer): EngineModule {
  return {
    containers: 'any',
    run: (blob, name, opts) =>
      analyzeWith(blob, name, opts, (found) => {
        if (found !== kind) throw withErrorCode('unsupported-container', wrongFamily(kind, found));
        return analyzer;
      }),
  };
}
