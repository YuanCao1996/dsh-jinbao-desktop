import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyPackage } from '../jinbao-launcher/update.mjs';

const [directory, archive, output] = process.argv.slice(2);
if (!directory || !archive || !output) throw Error('Usage: node update-metadata.mjs PACKAGE_DIR ZIP_PATH OUTPUT_JSON');
const root = resolve(directory), zip = resolve(archive);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = await readFile(join(root,'manifest.json'));
const { version } = JSON.parse(manifestBytes);
const release = { version,
  url:`https://api.jinbaoai.top/downloads/dsh/v${version}/jinbao-desktop-windows.zip`,
  bytes:(await stat(zip)).size,sha256:hash(await readFile(zip)),manifestSha256:hash(manifestBytes) };
await verifyPackage(root,release);
await writeFile(resolve(output),JSON.stringify(release));
console.log(JSON.stringify({version,bytes:release.bytes,metadataPrepared:true}));
