import {spawn} from 'node:child_process';
import {writeFile,existsSync,appendFileSync} from 'node:fs';
import {promisify} from 'node:util';
const write = promisify(writeFile);
const cwd = process.cwd();
const status = (data)=>write(cwd+'/.cloud-status.json',JSON.stringify(data));
async function command(cmd,args,env=process.env) {
  await new Promise((resolve,reject)=> {
    let output='';const child=spawn(cmd,args,{cwd,env,stdio:['ignore','pipe','pipe']});
    const capture=chunk=>{const text=String(chunk).replaceAll(process.env.BOBSHELL_API_KEY || '\0','[redacted]');output=(output+text).slice(-6000);appendFileSync(cwd+'/.cloud-bootstrap.log',text);};
    child.stdout.on('data',capture);child.stderr.on('data',capture);
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(cmd+' exited with '+code+': '+output.slice(-3000))));
  });
}
try {
  await status({ready:false,message:'Installing Docker in your isolated Vercel Sandbox…'});
  if (existsSync('/usr/bin/apt-get')) {
    await command('apt-get',['update']);
    await command('apt-get',['install','-y','docker.io'],{...process.env,DEBIAN_FRONTEND:'noninteractive'});
  } else { await command('dnf',['install','-y','docker']); }
  const docker=spawn('dockerd',['--storage-driver=vfs'],{cwd,stdio:'inherit'});
  docker.on('error',()=>{});
  let dockerReady=false;
  for(let i=0;i<60;i++) {try {await command('docker',['info']);dockerReady=true;break;}catch {await new Promise(r=>setTimeout(r,1000));}}
  if(!dockerReady)throw new Error('Docker daemon failed to start inside Vercel Sandbox');
  await status({ready:false,message:'Verifying isolated container execution under the VM resource limits…'});
  await command('docker',['run','--rm','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--read-only','--pids-limit','256','node:24-alpine','node','-e','console.log("PROOFRUN_CLOUD_EXECUTION_VERIFIED")']);
  process.env.PROOFRUN_CLOUD_VM='1';
  const ca='/etc/pki/ca-trust/source/anchors/vercel-proxy-ca.pem';
  if(existsSync(ca)) {process.env.NODE_EXTRA_CA_CERTS=ca;process.env.PROOFRUN_CONTAINER_CA=ca;}
  await status({ready:false,message:'Installing IBM Bob Shell and accepting the owner-approved license…'});
  await command('node',['scripts/install-bob.mjs']);
  process.env.PROOFRUN_BOB_ACCEPT_LICENSE='1';
  await status({ready:false,message:'Starting the testing engine…'});
  const gateway=spawn('node',['cloud/gateway.mjs'],{cwd,env:process.env,stdio:'inherit'});
  gateway.on('error',()=>{});
  let ready=false;
  for(let i=0;i<40;i++) {
    try {const response=await fetch('http://127.0.0.1:3001/api/qa/status',{headers:{authorization:'Bearer '+process.env.PROOFRUN_GATEWAY_KEY,'x-proofrun':'1'}});const body=await response.json();if(body.ready){ready=true;break;}}
    catch {}
    await new Promise(r=>setTimeout(r,1000));
  }
  if(!ready)throw new Error('The cloud testing engine did not become ready');
  await status({ready:true,message:'IBM Bob and Docker are ready. Your cloud workspace lasts up to 45 minutes.'});
} catch(error) {await status({ready:false,failed:true,message:error.message});process.exitCode=1;}
