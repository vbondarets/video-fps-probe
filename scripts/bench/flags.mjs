export function parseBrowserFlags(value) {
  return (value ?? '').split(/\s+/).filter(Boolean);
}
