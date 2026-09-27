import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
await mkdir('vercel-public',{recursive:true});
await cp('public','vercel-public',{recursive:true});
const html=(await readFile('public/workbench.html','utf8')).replace('src="/workbench.js"','src="/cloud-loader.js"').replace('Connect a local folder or upload a ZIP','Upload a ZIP').replace('id="local-path"','id="local-path" disabled hidden').replace('128 MB','3 MB').replace('32 MB per file','2 MB per file');
await writeFile('vercel-public/index.html',html);
await writeFile('vercel-public/project-limits.js',(await readFile('public/project-limits.js','utf8')).replace('128_000_000','3_000_000').replace('32_000_000','2_000_000').replace('180_000_000','4_000_000'));
await writeFile('vercel-public/workbench.js',(await readFile('public/workbench.js','utf8')).replaceAll('128 MB','3 MB'));
