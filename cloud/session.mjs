import { createHmac, timingSafeEqual } from 'node:crypto';
export function sign(value, secret) { return createHmac('sha256', secret).update(value).digest('base64url'); }
export function encodeSession(name, secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ name, expires: now + 45 * 60_000 })).toString('base64url');
  return payload + '.' + sign(payload, secret);
}
export function decodeSession(value, secret, now = Date.now()) {
  try {
    const [payload, signature] = value.split('.');
    const expected = sign(payload, secret);
    if (!signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const session = JSON.parse(Buffer.from(payload, 'base64url'));
    if (!/^proofrun-[a-f0-9-]{36}$/.test(session.name) || session.expires <= now) return null;
    return session;
  } catch { return null; }
}
export function validCode(actual, expected) {
  return typeof actual === 'string' && typeof expected === 'string' && expected.length >= 8 && actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
