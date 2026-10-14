import fs from 'node:fs/promises';
import path from 'node:path';
import { DefaultArtifactClient } from '@actions/artifact';
import { Encrypter, Decrypter } from 'age-encryption';
import { work } from './config.mjs';

export async function encryptReview(review, recipient = process.env.STATE_AGE_RECIPIENT) {
  if (!recipient) throw new Error('STATE_AGE_RECIPIENT must be configured');
  const encryption = new Encrypter();
  encryption.addRecipient(recipient);
  return encryption.encrypt(JSON.stringify(review));
}

export async function decryptReview(encrypted, identity = process.env.STATE_AGE_KEY) {
  if (!identity) throw new Error('STATE_AGE_KEY must be configured');
  const decryption = new Decrypter();
  decryption.addIdentity(identity.trim());
  return JSON.parse(await decryption.decrypt(encrypted, 'text'));
}

function artifactName(number, head, attempt) {
  return `review-${number}-${head}-${attempt}`;
}

export async function saveReview(review) {
  const directory = path.join(work, 'review');
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, 'review.age');
  await fs.writeFile(filename, await encryptReview({ ...review, source_sha: process.env.GITHUB_SHA, run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT }), { mode: 0o600 });
  const result = await new DefaultArtifactClient().uploadArtifact(artifactName(review.number, review.head, process.env.GITHUB_RUN_ATTEMPT), [filename], directory, { retentionDays: 90, compressionLevel: 0 });
  if (!result.id) throw new Error('Request review artifact was not uploaded');
  return result.id;
}

export async function loadReview(client, owner, repo, number, head, base) {
  const runs = (await Promise.all([base, head].map((sha) => client.paginate(client.rest.actions.listWorkflowRuns, { owner, repo, workflow_id: 'request.yml', head_sha: sha, status: 'success', per_page: 100 })))).flat();
  const seen = new Set();
  for (const run of runs) {
    if (seen.has(run.id)) continue;
    seen.add(run.id);
    if (!['pull_request_target', 'workflow_dispatch'].includes(run.event) || (run.event === 'workflow_dispatch' && (run.head_sha !== base || run.head_branch !== 'main')) || run.conclusion !== 'success' || run.repository.full_name !== `${owner}/${repo}`) continue;
    const artifacts = await client.paginate(client.rest.actions.listWorkflowRunArtifacts, { owner, repo, run_id: run.id, per_page: 100 });
    const artifact = artifacts.find((item) => item.name === artifactName(number, head, run.run_attempt) && !item.expired);
    if (!artifact) continue;
    if (!artifact.digest) throw new Error('GitHub must provide the review artifact digest');
    const directory = path.join(work, `download-review-${run.id}`);
    await fs.rm(directory, { recursive: true, force: true });
    const result = await new DefaultArtifactClient().downloadArtifact(artifact.id, { path: directory, expectedHash: artifact.digest, findBy: { token: process.env.CONTROL_TOKEN, workflowRunId: run.id, repositoryOwner: owner, repositoryName: repo } });
    if (result.digestMismatch) throw new Error('Review artifact digest does not match GitHub');
    const review = await decryptReview(await fs.readFile(path.join(directory, 'review.age')));
    if (review.number !== number || review.head !== head || review.base !== base || review.source_sha !== base || String(review.run_id) !== String(run.id) || String(review.run_attempt) !== String(run.run_attempt)) throw new Error('Review artifact does not match its trusted workflow run');
    return review;
  }
  throw new Error('A successful Request run with an unexpired review artifact is required; rerun preview before merging');
}
