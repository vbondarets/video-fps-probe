import Snippet from './Snippet.tsx';
import { ANALYZE_SNIPPET, COLOR_SNIPPET } from './snippets.ts';

export default function FilesIntro() {
  return (
    <div className="snippets">
      <Snippet title="Code: full analysis, median frame interval and enabled" pair={ANALYZE_SNIPPET} />
      <Snippet title="Code: color, HDR, Dolby Vision and aspect ratio" pair={COLOR_SNIPPET} />
    </div>
  );
}
