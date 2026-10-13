import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.OPENREEL_SOURCE_ROOT || resolve(here, '..'));
if (!existsSync(resolve(root, 'packages/agent/src/headless-host.ts'))) {
  throw new Error('Put hermes-cloud in the OpenReel fork root, next to packages/ and apps/.');
}
const workspaces = {
  '@openreel/core': 'packages/core/src',
  '@openreel/creation-schema': 'packages/creation-schema/src',
  '@openreel/agent': 'packages/agent/src',
};
const aliases = {name:'openreel-source', setup(builder) {
  builder.onResolve({filter:/^@openreel\//}, args => {
    for (const [name, path] of Object.entries(workspaces)) {
      if (args.path === name || args.path.startsWith(name + '/')) {
        const subpath = args.path === name ? 'index' : args.path.slice(name.length + 1);
        const base = resolve(root, path, subpath);
        return {path: existsSync(base + '.ts') ? base + '.ts' : resolve(base, 'index.ts')};
      }
    }
  });
}};
mkdirSync(resolve(here, 'dist'), {recursive:true});
await build({entryPoints:[resolve(here,'src/server.mjs')],outfile:resolve(here,'dist/server.mjs'),
  bundle:true,platform:'node',format:'esm',target:'node22',packages:'external',plugins:[aliases]});
await build({entryPoints:[resolve(here,'src/project.mjs')],outfile:resolve(here,'dist/project.mjs'),
  bundle:true,platform:'node',format:'esm',target:'node22',packages:'external',plugins:[aliases]});
copyFileSync(resolve(here,'src/render.py'), resolve(here,'dist/render.py'));
copyFileSync(resolve(here,'src/analyze.py'), resolve(here,'dist/analyze.py'));
console.log('BUILD_OK: real OpenReel HeadlessHost bundled; no desktop/browser runtime');
