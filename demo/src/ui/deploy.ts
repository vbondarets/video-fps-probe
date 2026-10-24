export const entryOf = (doc: Pick<Document, 'querySelector'>): string | null => doc.querySelector('script[type="module"][src]')?.getAttribute('src') || null;

export async function redeployed(url: string, entry: string | null): Promise<boolean> {
  if (!entry) return false;
  try {
    const page = await fetch(url, { cache: 'no-store' });
    return page.ok && !(await page.text()).includes(entry);
  } catch {
    return false;
  }
}
