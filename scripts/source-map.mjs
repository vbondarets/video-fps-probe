const B64 = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].map((c, i) => [c, i]));

export function decodeMappings(mappings) {
  const lines = [];
  let source = 0;
  for (const line of mappings.split(';')) {
    const segments = [];
    let column = 0;
    for (const segment of line ? line.split(',') : []) {
      const values = [];
      let value = 0;
      let shift = 0;
      for (const ch of segment) {
        const digit = B64.get(ch);
        if (digit === undefined) throw new Error(`invalid base64 VLQ digit ${ch}`);
        value += (digit & 31) * 2 ** shift;
        if (digit & 32) {
          shift += 5;
        } else {
          values.push(value % 2 === 1 ? -Math.floor(value / 2) : value / 2);
          value = 0;
          shift = 0;
        }
      }
      column += values[0];
      if (values.length >= 4) source += values[1];
      segments.push({ column, source: values.length >= 4 ? source : -1 });
    }
    lines.push(segments);
  }
  return lines;
}
