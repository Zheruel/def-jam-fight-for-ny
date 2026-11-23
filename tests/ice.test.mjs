import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { peerConfiguration } from '../tools/ice.mjs';

test('TURN credentials expire and validate against the server secret', () => {
  const env = { TURN_URL: 'turns:relay.example.com:5349', TURN_SECRET: 'test-secret' };
  const relay = peerConfiguration(env).iceServers[1];
  assert.equal(relay.urls, env.TURN_URL);
  assert.equal(relay.credential, createHmac('sha1', env.TURN_SECRET).update(relay.username).digest('base64'));
  assert.ok(Math.abs(Number(relay.username.split(':')[0]) - Date.now() / 1000 - 7200) < 2);
  assert.deepEqual(peerConfiguration({}), {});
  assert.throws(() => peerConfiguration({ TURN_URL: env.TURN_URL }));
});
