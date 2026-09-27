import { createServer, request } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createApp } from '../src/server.ts';
const token = process.env.PROOFRUN_GATEWAY_KEY;
if (!token) throw new Error('Gateway authentication is required');
const {server} = await createApp();
await new Promise((resolve,reject)=> { server.once('error',reject); server.listen(3000,'127.0.0.1',resolve); });
const gateway = createServer((req,res)=> {
  const actual = req.headers.authorization || '', expected = 'Bearer '+token;
  if (actual.length !== expected.length || !timingSafeEqual(Buffer.from(actual),Buffer.from(expected))) {res.writeHead(403);res.end('Forbidden');return;}
  if (!req.url.startsWith('/api/qa/')) {res.writeHead(404);res.end();return;}
  const headers = {...req.headers,host:'127.0.0.1:3000','x-proofrun':'1'};
  for(const key of ['authorization','origin','sec-fetch-site','cookie','connection']) delete headers[key];
  const upstream = request({hostname:'127.0.0.1',port:3000,path:req.url,method:req.method,headers},response=> {res.writeHead(response.statusCode,response.headers);response.pipe(res);});
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Backend unavailable');});
  req.pipe(upstream);
});
await new Promise((resolve,reject)=> {gateway.once('error',reject);gateway.listen(3001,'0.0.0.0',resolve);});
console.log('Authenticated cloud testing gateway ready');
