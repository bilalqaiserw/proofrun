import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeSession, decodeSession, validCode } from '../cloud/session.mjs';
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
