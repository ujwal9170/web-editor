// The device that renders an export already holds the finished MP4. Sharing
// it was fetching the whole file back from the server over the same
// connection that had just uploaded it -- on a phone that meant a two minute
// "Preparing MP4" for a file the browser had in hand the whole time. Keyed by
// the export id the server hands back once the save commits.
//
// Kept deliberately tiny and in its own module so the share dialog can read it
// without pulling in the render pipeline (deviceExport.ts is dynamically
// imported precisely so it stays out of the main bundle).
const recent = new Map<string, Blob>();
// Two covers "export something, then share it", including the case where a
// second export finishes while the first is still on screen, without keeping
// tens of megabytes of finished video alive for the rest of the session.
const KEEP = 2;
export function rememberExport(id: string, blob: Blob) {
  recent.delete(id);
  recent.set(id, blob);
  for (const key of [...recent.keys()].slice(0, -KEEP)) recent.delete(key);
}
export function rememberedExport(id: string) {
  return recent.get(id) ?? null;
}
export function forgetExport(id: string) {
  recent.delete(id);
}
