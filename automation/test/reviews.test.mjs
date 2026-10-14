import test from 'node:test';
import assert from 'node:assert/strict';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import { loadPolicy, digest } from '../scripts/config.mjs';
import { encryptReview, decryptReview } from '../scripts/reviews.mjs';

test('encrypted review preserves the policy digest and rejects alteration and unrelated keys', async () => {
  const policy = await loadPolicy();
  const identity = await generateX25519Identity();
  const recipient = await identityToRecipient(identity);
  const record = { organization: policy.organization, policy_digest: digest(policy), policy };
  const encrypted = await encryptReview(record, recipient);
  assert.ok(!Buffer.from(encrypted).includes(Buffer.from(record.policy_digest)));
  assert.deepEqual(await decryptReview(encrypted, identity), record);
  await assert.rejects(decryptReview(encrypted, await generateX25519Identity()));
  const damaged = Uint8Array.from(encrypted);
  damaged[damaged.length - 1] ^= 1;
  await assert.rejects(decryptReview(damaged, identity));
});
