import { Sandbox } from '@vercel/sandbox';
import { randomUUID } from 'node:crypto';
import { encodeSession, decodeSession, sign, validCode } from '../cloud/session.mjs';

async function launch(sandbox, name, secret) {
  const cwd = sandbox.cwd + '/proofrun';
  const script = await sandbox.readFileToBuffer({path:'cloud/bootstrap.mjs',cwd});
  if(!script) throw new Error('Repository checkout did not contain the cloud launcher.');
  await sandbox.writeFiles([{path:cwd+'/.cloud-started',content:Buffer.from('started')}]);
  await sandbox.runCommand({cmd:'node',args:['cloud/bootstrap.mjs'],cwd,sudo:true,detached:true,timeoutMs:45*60_000,
    env:{BOBSHELL_API_KEY:process.env.BOBSHELL_API_KEY,BOB_TEAM_ID:process.env.BOB_TEAM_ID || '',BOB_MAX_COST:process.env.BOB_MAX_COST || '5',PROOFRUN_GATEWAY_KEY:sign(name,secret),PROOFRUN_BOB_ACCEPT_LICENSE:'1',PROOFRUN_CLOUD_VM:'1',PORT:'3000'}});
}
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const reply = (status, data) => res.status(status).json(data);
  try {
    const secret = process.env.PROOFRUN_SESSION_SECRET || process.env.BOBSHELL_API_KEY;
    if (!secret || !process.env.PROOFRUN_ACCESS_CODE) return reply(503, {error:'The owner must add BOBSHELL_API_KEY and PROOFRUN_ACCESS_CODE (at least 8 characters) in Vercel settings.'});
    const origin = req.headers.origin;
    if ((origin && new URL(origin).host !== req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site') return reply(403, {error:'Same-origin request required.'});
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')));
    let session = decodeSession(cookies.proofrun_session || '', secret);
    const action = req.query.action;
    if (action === 'restart') {
      if(req.method!=='POST' || req.headers['x-proofrun']!=='1')return reply(403,{error:'Workspace request required.'});
      if(session) {
        const sandbox=await Sandbox.get({name:session.name});
        const status=await sandbox.readFileToBuffer({path:'.cloud-status.json',cwd:sandbox.cwd+'/proofrun'});
        if(!status || !JSON.parse(status.toString()).failed)return reply(409,{error:'Only failed setup sessions can be restarted. Running projects are preserved.'});
        await sandbox.stop();
      }
      res.setHeader('Set-Cookie','proofrun_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
      return reply(200,{ok:true});
    }
    if (action === 'init') {
      if (req.method !== 'POST' || req.headers['x-proofrun'] !== '1') return reply(403, {error:'Workspace request required.'});
      if (typeof req.body === 'string') req.body = JSON.parse(req.body);
      if (!session) {
        if (!validCode(req.body?.code, process.env.PROOFRUN_ACCESS_CODE)) return reply(401, {error:'Enter the access code supplied by the project owner.'});
        const name = 'proofrun-' + randomUUID();
        const sandbox = await Sandbox.create({
          name, image:'vercel/sandbox/universal:latest', ports:[3001],
          timeout:45 * 60_000, persistent:false, resources:{vcpus:2},
          source:{type:'git',url:'https://github.com/bilalqaiserw/proofrun.git',depth:1,revision:process.env.VERCEL_GIT_COMMIT_SHA || 'main'},
        });
        await launch(sandbox,name,secret);
        session = {name};
        res.setHeader('Set-Cookie', `proofrun_session=${encodeSession(name,secret)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2700`);
        return reply(202,{ready:false,message:'Preparing your private cloud testing environment. First startup installs Docker and IBM Bob.'});
      }
      const sandbox = await Sandbox.get({name:session.name});
      const status = await sandbox.readFileToBuffer({path:'.cloud-status.json',cwd:sandbox.cwd+'/proofrun'});
      if (!status) {
        const marker=await sandbox.readFileToBuffer({path:'.cloud-started',cwd:sandbox.cwd+'/proofrun'});
        if(!marker) await launch(sandbox,session.name,secret);
        return reply(200,{ready:false,message:'Preparing Docker and IBM Bob in your private cloud workspace…'});
      }
      return reply(200,JSON.parse(status.toString()));
    }
    if (!session) return reply(401,{error:'Cloud session expired. Refresh the page and enter your access code.'});
    const path = req.query.path;
    if (typeof path !== 'string' || !/^(status|projects)(\/[-a-zA-Z0-9]+)*$/.test(path)) return reply(404,{error:'Unknown workspace endpoint.'});
    if (!['GET','POST','DELETE'].includes(req.method)) return reply(405,{error:'Unsupported method.'});
    if (req.method !== 'GET' && req.headers['x-proofrun'] !== '1') return reply(403,{error:'Workspace request required.'});
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    if (body?.localPath) return reply(400,{error:'Cloud testing uses folder uploads or ZIP files; local server paths are unavailable.'});
    const encoded = req.method === 'GET' ? undefined : JSON.stringify(body || {});
    if (encoded && Buffer.byteLength(encoded) > 4_000_000) return reply(413,{error:'Cloud uploads must fit within 4 MB, including JSON encoding.'});
    const sandbox = await Sandbox.get({name:session.name});
    const target = new URL('/api/qa/' + path, sandbox.domain(3001));
    for (const [key,value] of Object.entries(req.query)) if (!['path','action'].includes(key) && typeof value === 'string') target.searchParams.set(key,value);
    const upstream = await fetch(target,{method:req.method,headers:{authorization:'Bearer '+sign(session.name,secret),'content-type':'application/json','x-proofrun':'1'},body:encoded,signal:AbortSignal.timeout(240_000),redirect:'error'});
    for (const header of ['content-type','content-disposition','x-content-type-options']) if(upstream.headers.has(header)) res.setHeader(header,upstream.headers.get(header));
    res.status(upstream.status).send(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    console.error('Cloud runner:', String(error.message).replaceAll(process.env.BOBSHELL_API_KEY || '\0','[redacted]'));
    return reply(503,{error:'Cloud execution is unavailable: '+String(error.message).replaceAll(process.env.BOBSHELL_API_KEY || '\0','[redacted]').slice(0,500)});
  }
}
