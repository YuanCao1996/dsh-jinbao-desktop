import { cp, mkdtemp, mkdir, realpath, rm, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A private SDK composition, never npm-install into or mutate the running product.
export async function prepareSdkFixture() {
  const temporaryRoot = await realpath(tmpdir());
  const folder = await mkdtemp(join(temporaryRoot, 'jinbao-generic-sdk-'));
  const source = fileURLToPath(new URL('../../../', import.meta.url));
  const sourceRequire = createRequire(new URL('../../../package.json', import.meta.url));
  // Resolve exactly the SDK graph used by this project. Copying node_modules
  // wholesale also follows unrelated, possibly stale links to a user's profile.
  const copied=new Set();
  async function packageManifest(name){
    for(const base of sourceRequire.resolve.paths(name)??[]){const path=join(base,name,'package.json');try{const data=JSON.parse(await readFile(path,'utf8'));if(data.name===name)return path;}catch(error){if(error.code!=='ENOENT')throw error;}}
    throw Object.assign(Error('Missing SDK fixture dependency: '+name),{code:'ENOENT'});
  }
  async function copyPackage(name){
    if(copied.has(name))return;copied.add(name);
    const manifest=await packageManifest(name),directory=dirname(manifest),data=JSON.parse(await readFile(manifest,'utf8'));
    await cp(directory,join(folder,'node_modules',name),{recursive:true,dereference:true,filter:path=>path===directory||!path.slice(directory.length+1).split(/[\\/]/).includes('node_modules')});
    for(const dependency of Object.keys({...data.dependencies,...data.peerDependencies})){
      try{await packageManifest(dependency);}catch(error){if(data.peerDependenciesMeta?.[dependency]?.optional)continue;throw error;}
      await copyPackage(dependency);
    }
  }
  for(const name of ['@deepseek-ai/cordis','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-scope','@deepseek-ai/dsh-llm'])await copyPackage(name);
  for (const name of ['generic-game-assistant', 'game-observation']) {
    await cp(join(source, 'tools', name), join(folder, 'tools', name), { recursive: true,
      filter: path => !path.includes(`${name}\\tests`) && !path.includes(`${name}/tests`) });
  }
  await mkdir(join(folder, 'tools/dsh-coach-server/lib'), { recursive: true });
  // The helper has a .js ESM import; put its package marker beside the unmodified source.
  await cp(join(source, 'tools/dsh-coach-server/package.json'), join(folder, 'tools/dsh-coach-server/package.json'));
  await cp(join(source, 'tools/dsh-coach-server/lib/session-runtime.js'), join(folder, 'tools/dsh-coach-server/lib/session-runtime.js'));
  const dependency = createRequire(pathToFileURL(join(folder, 'tools/generic-game-assistant/package.json')));
  const load = specifier => import(pathToFileURL(dependency.resolve(specifier)).href);
  return {
    folder, load,
    module: path => import(pathToFileURL(join(folder, 'tools/generic-game-assistant', path)).href),
    async dispose() {
      const resolved = await realpath(folder);
      if (dirname(resolved) !== temporaryRoot || !basename(resolved).startsWith('jinbao-generic-sdk-')) {
        throw new Error('unsafe_fixture_cleanup');
      }
      await rm(resolved, { recursive: true, force: true });
    },
  };
}
