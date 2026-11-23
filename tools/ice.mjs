import { createHmac, randomBytes } from 'node:crypto';

// coturn REST authentication. Only the expiring credential is sent to peers.
export function peerConfiguration(env = process.env) {
  if (!env.TURN_URL && !env.TURN_SECRET) return {};
  if (!/^turns?:[^\s]+$/.test(env.TURN_URL || '') || !env.TURN_SECRET) {
    throw new Error('Set both TURN_URL and TURN_SECRET to enable relay connections.');
  }
  const username = Math.floor(Date.now() / 1000 + 7200) + ':' + randomBytes(12).toString('hex');
  const credential = createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
  return { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: env.TURN_URL, username, credential }
  ] };
}
