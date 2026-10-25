/*
 * Atomic writes for the app's small JSON state files under /data.
 *
 * writeFileSync truncates and then writes, so a reader in between (another
 * request, a test, the next startup after a crash mid-write) can see an empty
 * or half-written file — `Unexpected end of JSON input`. Writing a temporary
 * file next to it and renaming over the target is atomic on the same
 * filesystem: readers see the old file or the new one, never a partial one.
 */
import { writeFileSync, renameSync, unlinkSync } from 'fs';

export function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}
