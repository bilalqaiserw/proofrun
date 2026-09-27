import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeSession, decodeSession, validCode } from '../cloud/session.mjs';
import { allowedWorkspacePath } from '../cloud/routes.mjs';
test('cloud screenshot routes allow captured PNG evidence but reject traversal and arbitrary extensions',()=>{
 const project='12345678-1234-1234-1234-123456789012';
 assert.equal(allowedWorkspacePath(`projects/${project}/artifact/proofrun-browser-final.png`),true);
 for(const suffix of ['../secret.png','secret.json','file.png/extra','%2e%2e/file.png','file.png?secret=1'])
   assert.equal(allowedWorkspacePath(`projects/${project}/artifact/${suffix}`),false);
 assert.equal(allowedWorkspacePath(undefined),false);
});
test('cloud sessions reject forgery and expiry',()=>{
 const name='proofrun-12345678-1234-1234-1234-123456789012', key='server-key';
 const value=encodeSession(name,key,1000);
 assert.equal(decodeSession(value,key,1001).name,name);
 assert.equal(decodeSession(value,'other-key',1001),null);
 assert.equal(decodeSession(value,key,2701001),null);
 assert.equal(decodeSession(value+'x',key,1001),null);
});
test('cloud access code requires eight characters and exact match',()=>{
 assert.equal(validCode('abcdefgh','abcdefgh'),true);
 assert.equal(validCode('wrongkey','abcdefgh'),false);
 assert.equal(validCode('short','short'),false);
 assert.equal(validCode('ébcdefgh','abcdefgh'),false);
});
