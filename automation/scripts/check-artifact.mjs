import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DefaultArtifactClient } from '@actions/artifact';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import { work, loadPolicy, digest } from './config.mjs';
import { encryptReview, decryptReview } from './reviews.mjs';

try {
  const [repositoryOwner, repositoryName] = process.env.GITHUB_REPOSITORY.split('/');
  const record = { run_id: process.env.GITHUB_RUN_ID, sha: process.env.GITHUB_SHA, policy_digest: digest(await loadPolicy()) };
  const identity = await generateX25519Identity();
  const recipient = await identityToRecipient(identity);
  const directory = path.join(work, 'artifact-verification');
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, 'review.age');
  await fs.writeFile(filename, await encryptReview(record, recipient), { mode: 0o600 });
  const client = new DefaultArtifactClient();
  const artifact = await client.uploadArtifact(`encrypted-review-verification-${process.env.GITHUB_RUN_ATTEMPT}`, [filename], directory, { retentionDays: 1, compressionLevel: 0 });
  assert.ok(artifact.id && artifact.digest);
  const downloaded = path.join(directory, 'download');
  const result = await client.downloadArtifact(artifact.id, { path: downloaded, expectedHash: `sha256:${artifact.digest}`, findBy: { token: process.env.CONTROL_TOKEN, workflowRunId: Number(process.env.GITHUB_RUN_ID), repositoryOwner, repositoryName } });
  assert.equal(result.digestMismatch, false);
  assert.deepEqual(await decryptReview(await fs.readFile(path.join(downloaded, 'review.age')), identity), record);
  console.log('Verified encrypted review upload, authenticated REST download, digest and age decryption');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
