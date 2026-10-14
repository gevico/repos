import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { StateStore } from './state.mjs';

let holder;
let competitor;
let acquired = false;
const lock = { ID: randomUUID(), Operation: 'backend-lock-verification', Who: hostname(), Version: '1.12.2', Created: new Date().toISOString(), Path: 'gevico/repos/terraform.tfstate' };

try {
  holder = await StateStore.open();
  const before = await holder.terraformState();
  const response = await fetch(holder.url, { method: 'LOCK', headers: { ...holder.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(lock), signal: AbortSignal.timeout(60_000) });
  assert.equal(response.status, 200, 'The write App must acquire the remote Git lock');
  acquired = true;
  competitor = await StateStore.open();
  const conflict = await fetch(competitor.url, { method: 'LOCK', headers: { ...competitor.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...lock, ID: randomUUID() }), signal: AbortSignal.timeout(60_000) });
  assert.equal(conflict.status, 409, 'A separate backend process must reject the concurrent lock');
  assert.equal((await conflict.json()).ID, lock.ID);
  assert.equal((await competitor.terraformState()).version, before.version);
  console.log('Verified real Git state read and remote lock conflict across separate backend processes');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (acquired) {
    try {
      const response = await fetch(holder.url, { method: 'UNLOCK', headers: { ...holder.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(lock), signal: AbortSignal.timeout(60_000) });
      if (response.status !== 200) throw new Error('Remote verification lock could not be released');
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
  if (competitor) await competitor.close();
  if (holder) await holder.close();
}
