import { access, cp, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function copyDependency(source, destination) {
  let info;
  try { info = await lstat(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (info?.isSymbolicLink()) {
    // Existing DSH installations may link to a shared pnpm/development store.
    // The installer checks versions before this call. Never write through that
    // link into another checkout; verify the bundled runtime files are present.
    async function verify(from, to) {
      for (const entry of await readdir(from, { withFileTypes: true })) {
        const target = join(to, entry.name);
        try { await access(target); } catch {
          throw Error('Linked DSH dependency is incomplete: ' + target + '; repair that dependency before installing Jinbao.');
        }
        if (entry.isDirectory()) await verify(join(from, entry.name), target);
      }
    }
    await verify(source, destination);
    return;
  }
  await cp(source, destination, { recursive: true, force: false });
}
