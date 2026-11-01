import type { ErrorClass, FileErrorCode, WarningCode } from 'video-fps-probe';
import { errorClass } from 'video-fps-probe/header';
import { CLASS_TEXT, ERROR_TEXT, WARNING_TEXT } from './codes.ts';
import Snippet from './Snippet.tsx';
import { ERRORS_SNIPPET } from './snippets.ts';

const CODES = Object.keys(ERROR_TEXT) as FileErrorCode[];
const CLASSES = Object.keys(CLASS_TEXT) as ErrorClass[];
const WARNINGS = Object.keys(WARNING_TEXT) as WarningCode[];

export default function ErrorsPanel() {
  return (
    <div className="panel-body">
      <p className="intro">
        A failed result keeps its plain <code>error</code> text and carries <code>errorCode</code>, a stable code to branch on.{' '}
        <code>errorClass</code> sorts the codes for caching and retries, and <code>warningCodesOf</code> gives the codes of the warnings that
        have one. The cards in the other tabs show the code and its class next to every error.
      </p>
      <Snippet title="Code: decide what to do with a result" pair={ERRORS_SNIPPET} />
      <h3>Error codes</h3>
      <div className="scroll">
        <table className="codes" aria-label="Error codes">
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Class</th>
              <th scope="col">Meaning</th>
            </tr>
          </thead>
          <tbody>
            {CODES.map((code) => (
              <tr key={code} data-code={code}>
                <th scope="row" className="mono">
                  {code}
                </th>
                <td>{errorClass(code)}</td>
                <td>{ERROR_TEXT[code]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Classes</h3>
      <dl className="classes">
        {CLASSES.map((c) => (
          <div key={c}>
            <dt className="mono">{c}</dt>
            <dd>{CLASS_TEXT[c]}</dd>
          </div>
        ))}
      </dl>
      <h3>Warning codes</h3>
      <div className="scroll">
        <table className="codes" aria-label="Warning codes">
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Meaning</th>
            </tr>
          </thead>
          <tbody>
            {WARNINGS.map((code) => (
              <tr key={code} data-code={code}>
                <th scope="row" className="mono">
                  {code}
                </th>
                <td>{WARNING_TEXT[code]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
