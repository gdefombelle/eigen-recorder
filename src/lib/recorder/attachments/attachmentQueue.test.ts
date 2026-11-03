/**
 * Tests for the persistent attachment queue.
 *
 * Storage is an in-memory stand-in for IndexedDB that OUTLIVES queue instances,
 * so "restart the app" = build a new queue over the same storage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/auth/api', async () => {
  const actual = await vi.importActual<typeof import('$lib/auth/api')>('$lib/auth/api');
  return { ...actual, request: vi.fn(), uploadMultipart: vi.fn() };
});
vi.mock('../offlineStorage', () => ({ offlineStorage: {} }));

import { createAttachmentQueue, backoffDelayMs, BACKOFF_MAX_MS, type AttachmentStorage, type AttachmentQueueEvent } from './attachmentQueue';
import { MockAttachmentApi } from './mockAttachmentApi';
import { AttachmentTooLargeError } from './attachmentApi';
import { MAX_ATTACHMENT_BYTES } from './types';
import type { LocalAttachment } from './localTypes';

// ── harness ──────────────────────────────────────────────────────────────────

function memoryStorage(): AttachmentStorage {
  const meta = new Map<string, LocalAttachment>();
  const data = new Map<string, Blob>();
  return {
    async putAttachment(m, blob) { meta.set(m.local_attachment_id, structuredClone(m)); if (blob) data.set(m.local_attachment_id, blob); },
    async getAttachment(id) { const m = meta.get(id); return m ? structuredClone(m) : undefined; },
    async getAttachmentsBySession(s) { return [...meta.values()].filter((m) => m.local_session_id === s).map((m) => structuredClone(m)); },
    async getAllAttachments() { return [...meta.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((m) => structuredClone(m)); },
    async getAttachmentBlob(id) { return data.get(id); },
    async deleteAttachment(id) { meta.delete(id); data.delete(id); },
  };
}

interface Env {
  storage: AttachmentStorage;
  api: MockAttachmentApi;
  /** local_session_id → backend id (absent = "Local only", not shared yet) */
  sessions: Map<string, string>;
  clock: { t: number };
  online: { v: boolean };
  timers: Array<{ fn: () => void; ms: number }>;
  newQueue(): ReturnType<typeof createAttachmentQueue>;
}

function makeEnv(): Env {
  const env = {
    storage: memoryStorage(),
    api: new MockAttachmentApi(),
    sessions: new Map<string, string>(),
    clock: { t: 1_000_000 },
    online: { v: true },
    timers: [] as Array<{ fn: () => void; ms: number }>,
  } as Env;
  let n = 0;
  env.newQueue = () => createAttachmentQueue({
    storage: env.storage,
    getApi: async () => env.api,
    getRemoteSessionId: async (id) => env.sessions.get(id) ?? null,
    isOnline: () => env.online.v,
    now: () => env.clock.t,
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    random: () => 0.5,                    // jitter factor exactly 1.0
    setTimer: (fn, ms) => { env.timers.push({ fn, ms }); return env.timers.length; },
    clearTimer: () => { /* timers are inspected, never fired automatically */ },
  });
  return env;
}

// SHA-256 of the 4 bytes 'jpeg' used as every test photo's content: the queue verifies the stored copy before sending.
const JPEG_SHA = '41e5787e9f28562d07b891b1816b492309d646c0f2829743fa4963a9f9cc1d61';

const photo = (title = 'Whiteboard', over: Record<string, unknown> = {}) => ({
  localSessionId: 'local-1',
  file: new Blob(['jpeg'], { type: 'image/jpeg' }),
  filename: 'p.jpg', kind: 'photo' as const,
  startOffsetMs: 10_000, sha256: JPEG_SHA, title,
  ...over,
});

let env: Env;
beforeEach(() => { env = makeEnv(); });

// ── offline add, share later ─────────────────────────────────────────────────

describe('"Local only" mode — add offline, share later', () => {
  it('waits while the backend session does not exist, then leaves with the right session id', async () => {
    env.online.v = false;
    const q = env.newQueue();

    const att = await q.add(photo());          // offline AND no backend session
    await q.whenIdle();
    expect(env.api.uploadAttempts).toBe(0);
    expect((await env.storage.getAttachment(att.local_attachment_id))?.state).toBe('queued');

    // network is back, but the audio has not been shared yet → still nothing to send to
    env.online.v = true;
    await q.kick();
    expect(env.api.uploadAttempts).toBe(0);

    // sharing the audio creates the backend session
    env.sessions.set('local-1', 'srv-42');
    await q.kick();

    const stored = await env.storage.getAttachment(att.local_attachment_id);
    expect(stored?.state).toBe('uploaded');
    const onServer = await env.api.list('srv-42');
    expect(onServer).toHaveLength(1);
    expect(onServer[0].client_attachment_id).toBe(att.local_attachment_id);
    expect(onServer[0].start_offset_ms).toBe(10_000);
  });

  it('no request is ever made under the local id', async () => {
    const q = env.newQueue();
    await q.add(photo());
    await q.whenIdle();
    expect(await env.api.list('local-1')).toHaveLength(0);
    expect(env.api.uploadAttempts).toBe(0);
  });
});

// ── restart ──────────────────────────────────────────────────────────────────

describe('restart recovery', () => {
  it('queued items survive an app restart and are sent by the new queue', async () => {
    env.online.v = false;
    env.sessions.set('local-1', 'srv-1');
    const a = await env.newQueue().add(photo());

    // app killed; new process, same persisted storage
    env.online.v = true;
    const q2 = env.newQueue();
    await q2.start();
    await q2.whenIdle();

    expect((await env.storage.getAttachment(a.local_attachment_id))?.state).toBe('uploaded');
    expect(await env.api.list('srv-1')).toHaveLength(1);
  });

  it('an upload killed mid-flight is resent with the SAME UUID and does not create a duplicate', async () => {
    env.sessions.set('local-1', 'srv-1');
    const q1 = env.newQueue();
    const a = await q1.add(photo());
    await q1.whenIdle();           // first process is done — nothing may still be running at "kill" time

    // simulate: the server stored it, but the app died before recording the answer
    await env.api.upload({
      sessionId: 'srv-1', file: new Blob(['jpeg']), filename: 'p.jpg',
      clientAttachmentId: a.local_attachment_id, startOffsetMs: 10_000, sha256: 'a'.repeat(64), title: 'Whiteboard',
    });
    const row = (await env.storage.getAttachment(a.local_attachment_id))!;
    await env.storage.putAttachment({ ...row, state: 'uploading', server_attachment_id: null, upload_started: true });

    const q2 = env.newQueue();
    expect((await env.storage.getAttachment(a.local_attachment_id))?.state).toBe('uploading');   // what the dead process left behind
    await q2.start();
    await q2.whenIdle();

    expect((await env.storage.getAttachment(a.local_attachment_id))?.state).toBe('uploaded');
    expect(await env.api.list('srv-1')).toHaveLength(1);
  });
});

// ── cancelled session ────────────────────────────────────────────────────────

describe('cancelled session', () => {
  it('abandons the unsent items, keeps the already-uploaded ones, and notifies', async () => {
    env.sessions.set('local-1', 'srv-1');
    const q = env.newQueue();
    const events: AttachmentQueueEvent[] = [];
    q.subscribe((e) => events.push(e));

    const done = await q.add(photo('sent'));
    await q.whenIdle();
    expect((await env.storage.getAttachment(done.local_attachment_id))?.state).toBe('uploaded');

    env.api.setSessionState('srv-1', 'cancelled');
    const a = await q.add(photo('late 1'));
    const b = await q.add(photo('late 2'));
    await q.whenIdle();

    expect((await env.storage.getAttachment(a.local_attachment_id))?.state).toBe('abandoned');
    expect((await env.storage.getAttachment(b.local_attachment_id))?.state).toBe('abandoned');
    expect((await env.storage.getAttachment(done.local_attachment_id))?.state).toBe('uploaded');
    expect(events.find((e) => e.type === 'session_cancelled')).toMatchObject({ localSessionId: 'local-1', abandoned: 2 });
  });

  it('does not keep hitting the server once abandoned', async () => {
    env.sessions.set('local-1', 'srv-1');
    env.api.setSessionState('srv-1', 'cancelled');
    const q = env.newQueue();
    await q.add(photo());
    await q.whenIdle();
    const attempts = env.api.uploadAttempts;

    await q.kick(); await q.kick();
    expect(env.api.uploadAttempts).toBe(attempts);
  });

  it('a CLOSED session still receives the queued items', async () => {
    env.online.v = false;
    env.sessions.set('local-1', 'srv-1');
    const q = env.newQueue();
    const a = await q.add(photo());

    env.api.setSessionState('srv-1', 'closed');
    env.online.v = true;
    await q.kick();

    expect((await env.storage.getAttachment(a.local_attachment_id))?.state).toBe('uploaded');
  });
});

// ── retry policy ─────────────────────────────────────────────────────────────

describe('retry policy', () => {
  it.each([[0], [503], [429]])('status %i → stays queued with exponential backoff, no immediate retry', async (status) => {
    env.sessions.set('local-1', 'srv-1');
    env.api.failNext(status);
    const q = env.newQueue();

    const a = await q.add(photo());
    await q.whenIdle();

    const row = (await env.storage.getAttachment(a.local_attachment_id))!;
    expect(row.state).toBe('queued');
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at).toBe(env.clock.t + 2_000);
    expect(env.timers.at(-1)?.ms).toBe(2_000);

    await q.kick();                                    // too early: still backing off
    expect(env.api.uploadAttempts).toBe(1);

    env.clock.t += 2_000;
    await q.kick();                                    // due → succeeds
    expect((await env.storage.getAttachment(a.local_attachment_id))?.state).toBe('uploaded');
  });

  it('backoff doubles on each failure and is capped', async () => {
    env.sessions.set('local-1', 'srv-1');
    const q = env.newQueue();
    for (let i = 0; i < 3; i++) env.api.failNext(503);
    const a = await q.add(photo());
    await q.whenIdle();
    const delays: number[] = [];
    for (let i = 0; i < 2; i++) {
      const row = (await env.storage.getAttachment(a.local_attachment_id))!;
      delays.push(row.next_attempt_at! - env.clock.t);
      env.clock.t = row.next_attempt_at!;
      await q.kick();
    }
    expect(delays).toEqual([2_000, 4_000]);
    expect(backoffDelayMs(30, () => 0.5)).toBe(BACKOFF_MAX_MS);
  });

  it.each([[400], [403], [404], [413], [422]])('status %i → Failed immediately, no automatic retry', async (status) => {
    env.sessions.set('local-1', 'srv-1');
    env.api.failNext(status);
    const q = env.newQueue();

    const a = await q.add(photo());
    await q.whenIdle();

    const row = (await env.storage.getAttachment(a.local_attachment_id))!;
    expect(row.state).toBe('failed');
    expect(row.last_error?.status).toBe(status);
    expect(env.timers).toHaveLength(0);                // nothing scheduled

    env.clock.t += 10 * 60_000;
    await q.kick();
    expect(env.api.uploadAttempts).toBe(1);            // no loop
  });

  it('manual Retry resends the full file with the same UUID', async () => {
    env.sessions.set('local-1', 'srv-1');
    env.api.failNext(422);
    const q = env.newQueue();
    const a = await q.add(photo());
    await q.whenIdle();

    await q.retry(a.local_attachment_id);
    await q.whenIdle();

    const row = (await env.storage.getAttachment(a.local_attachment_id))!;
    expect(row.state).toBe('uploaded');
    expect((await env.api.list('srv-1'))[0].client_attachment_id).toBe(a.local_attachment_id);
  });

  it('Retry on a server-side failed attachment calls POST /retry instead of re-uploading', async () => {
    env.sessions.set('local-1', 'srv-1');
    const q = env.newQueue();
    const a = await q.add(photo());
    await q.whenIdle();
    const row = (await env.storage.getAttachment(a.local_attachment_id))!;
    await env.storage.putAttachment({ ...row, server_status: 'failed' });
    const retrySpy = vi.spyOn(env.api, 'retry').mockResolvedValue({ ...(await env.api.list('srv-1'))[0], status: 'processing' });
    const uploadsBefore = env.api.uploadAttempts;

    await q.retry(a.local_attachment_id);

    expect(retrySpy).toHaveBeenCalledWith('srv-1', row.server_attachment_id);
    expect(env.api.uploadAttempts).toBe(uploadsBefore);
    expect((await env.storage.getAttachment(a.local_attachment_id))?.server_status).toBe('processing');
  });
});

// ── delete ───────────────────────────────────────────────────────────────────

describe('delete', () => {
  it('never sent → just removed from the queue, no request', async () => {
    env.online.v = false;
    const q = env.newQueue();
    const a = await q.add(photo());

    await q.remove(a.local_attachment_id);

    expect(await env.storage.getAttachment(a.local_attachment_id)).toBeUndefined();
    expect(await env.storage.getAttachmentBlob(a.local_attachment_id)).toBeUndefined();
    expect(env.api.uploadAttempts).toBe(0);
  });

  it('already created server-side → DELETE, then dropped locally', async () => {
    env.sessions.set('local-1', 'srv-1');
    const q = env.newQueue();
    const a = await q.add(photo());
    await q.whenIdle();
    const removeSpy = vi.spyOn(env.api, 'remove');

    await q.remove(a.local_attachment_id);
    await q.whenIdle();

    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(await env.api.list('srv-1')).toHaveLength(0);
    expect(await env.storage.getAttachment(a.local_attachment_id)).toBeUndefined();
  });

  it('deleted while offline → kept as pending_delete, DELETE sent on reconnection', async () => {
    env.sessions.set('local-1', 'srv-1');
    const q = env.newQueue();
    const a = await q.add(photo());
    await q.whenIdle();

    env.online.v = false;
    await q.remove(a.local_attachment_id);
    expect((await env.storage.getAttachment(a.local_attachment_id))?.pending_delete).toBe(true);
    expect(await env.api.list('srv-1')).toHaveLength(1);

    env.online.v = true;
    await q.kick();
    expect(await env.api.list('srv-1')).toHaveLength(0);
    expect(await env.storage.getAttachment(a.local_attachment_id)).toBeUndefined();
  });

  it('mid-upload → upload aborted, then DELETE by client UUID so a server copy cannot survive', async () => {
    env.sessions.set('local-1', 'srv-1');
    const slow = new MockAttachmentApi({ stepDelayMs: 5, steps: 20 });
    env.api = slow;
    const q = env.newQueue();
    let lastProgress = 0;
    q.subscribe((e) => { if (e.type === 'progress') lastProgress = e.fraction; });

    const a = await q.add(photo());
    // wait until the upload is actually in flight
    await vi.waitFor(async () => {
      expect((await env.storage.getAttachment(a.local_attachment_id))?.state).toBe('uploading');
    });
    await q.remove(a.local_attachment_id);
    await q.whenIdle();

    expect(lastProgress).toBeLessThan(1);                 // the upload was cancelled, not allowed to finish
    expect(await slow.list('srv-1')).toHaveLength(0);
    expect(await env.storage.getAttachment(a.local_attachment_id)).toBeUndefined();
  });

  it('mid-upload, but the server had already created it → it is deleted, not left orphaned', async () => {
    env.sessions.set('local-1', 'srv-1');
    const q = env.newQueue();
    const a = await q.add(photo());
    await q.whenIdle();
    // Rewind the local row to "in flight" while the server holds the copy (response lost).
    const row = (await env.storage.getAttachment(a.local_attachment_id))!;
    await env.storage.putAttachment({ ...row, state: 'uploading', server_attachment_id: null, server_status: null });

    await q.remove(a.local_attachment_id);
    await q.whenIdle();

    expect(await env.api.list('srv-1')).toHaveLength(0);
  });

  it('DELETE answering 404 (server never created it) just clears the row', async () => {
    env.sessions.set('local-1', 'srv-1');
    env.api.failNext(503);
    const q = env.newQueue();
    const a = await q.add(photo());            // upload failed transiently: upload_started = true, nothing on server
    await q.whenIdle();

    await q.remove(a.local_attachment_id);
    await q.whenIdle();

    expect(await env.storage.getAttachment(a.local_attachment_id)).toBeUndefined();
  });
});

// ── misc contract ────────────────────────────────────────────────────────────

describe('add()', () => {
  it('multi-selection: one UUID per file, same offset', async () => {
    env.online.v = false;
    const q = env.newQueue();
    const [x, y, z] = await q.addMany(
      { localSessionId: 'local-1', kind: 'photo', startOffsetMs: 46_000 },
      [1, 2, 3].map((i) => ({ file: new Blob([`img${i}`], { type: 'image/jpeg' }), filename: `${i}.jpg`, sha256: String(i).repeat(64), title: `Photo ${i}` })),
    );
    expect(new Set([x, y, z].map((a) => a.local_attachment_id)).size).toBe(3);
    expect([x, y, z].map((a) => a.start_offset_ms)).toEqual([46_000, 46_000, 46_000]);
  });

  it('refuses a file over 25 MB before storing anything', async () => {
    const q = env.newQueue();
    const big = { size: MAX_ATTACHMENT_BYTES + 1, type: 'application/pdf' } as unknown as Blob;
    await expect(q.add(photo('big', { file: big }))).rejects.toBeInstanceOf(AttachmentTooLargeError);
    expect(await env.storage.getAllAttachments()).toHaveLength(0);
  });

  it('persists file, UUID, offset and title before any network attempt', async () => {
    env.online.v = false;
    const a = await env.newQueue().add(photo('Schéma', { startOffsetMs: 21_049.6 }));
    const row = (await env.storage.getAttachment(a.local_attachment_id))!;
    expect(row).toMatchObject({ title: 'Schéma', start_offset_ms: 21_050, state: 'queued' });
    expect(await (await env.storage.getAttachmentBlob(a.local_attachment_id))?.text()).toBe('jpeg');
  });

  it('uploads one at a time, in timeline order of creation', async () => {
    env.sessions.set('local-1', 'srv-1');
    env.online.v = false;
    const q = env.newQueue();
    for (const t of ['a', 'b', 'c']) { await q.add(photo(t)); env.clock.t += 1; }
    env.online.v = true;
    await q.kick();
    expect((await env.api.list('srv-1')).length).toBe(3);
  });
});

describe('rename', () => {
  it('PATCHes the title once the attachment exists server-side', async () => {
    env.sessions.set('local-1', 'srv-1');
    const q = env.newQueue();
    const a = await q.add(photo('old'));
    await q.whenIdle();

    await q.rename(a.local_attachment_id, 'new');
    await q.whenIdle();

    expect((await env.api.list('srv-1'))[0].title).toBe('new');
    expect((await env.storage.getAttachment(a.local_attachment_id))?.title_dirty).toBe(false);
  });

  it('renamed before it is uploaded → the upload simply carries the new title', async () => {
    env.online.v = false;
    const q = env.newQueue();
    const a = await q.add(photo('old'));
    await q.rename(a.local_attachment_id, 'new');
    env.sessions.set('local-1', 'srv-1'); env.online.v = true;
    await q.kick();
    expect((await env.api.list('srv-1'))[0].title).toBe('new');
  });
});

describe('ApiError wiring', () => {
  it('an unknown 409 (not session_cancelled) fails that item only; it does not abandon the session', async () => {
    env.sessions.set('local-1', 'srv-1');
    env.api.failNext(409, 'something else');
    const q = env.newQueue();
    const a = await q.add(photo('one'));
    await q.whenIdle();
    const b = await q.add(photo('two'));
    await q.whenIdle();

    expect((await env.storage.getAttachment(a.local_attachment_id))?.state).toBe('failed');
    expect((await env.storage.getAttachment(b.local_attachment_id))?.state).toBe('uploaded');
  });
});


describe('retryAll — the end-of-record "Retry" button', () => {
  it('re-sends failed items and skips the backoff wait of queued ones, leaving abandoned ones alone', async () => {
    env.sessions.set('local-1', 'srv-1');
    const q = env.newQueue();
    env.api.failNext(422);
    const failed = await q.add(photo('failed'));
    await q.whenIdle();
    env.api.failNext(503);
    const backingOff = await q.add(photo('backing off'));
    await q.whenIdle();
    const abandoned = await q.add(photo('abandoned'));
    await q.whenIdle();
    await env.storage.putAttachment({ ...(await env.storage.getAttachment(abandoned.local_attachment_id))!, state: 'abandoned' });
    expect((await env.storage.getAttachment(failed.local_attachment_id))?.state).toBe('failed');
    expect((await env.storage.getAttachment(backingOff.local_attachment_id))?.next_attempt_at).toBeGreaterThan(env.clock.t);

    await q.retryAll('local-1');                      // clock NOT advanced: the 2 s backoff would still be running

    expect((await env.storage.getAttachment(failed.local_attachment_id))?.state).toBe('uploaded');
    expect((await env.storage.getAttachment(backingOff.local_attachment_id))?.state).toBe('uploaded');
    expect((await env.storage.getAttachment(abandoned.local_attachment_id))?.state).toBe('abandoned');
  });
});


describe('unexpected errors are visible, not silent', () => {
  it('an exception before the request (e.g. local storage read) is recorded as the last error, backs off, and does not stall the other items', async () => {
    env.sessions.set('local-1', 'srv-1');
    const q = env.newQueue();
    const bad = await q.add(photo('bad'));
    await q.whenIdle();
    const good = await q.add(photo('good'));
    await q.whenIdle();
    // rewind both to queued; make the FIRST one's blob unreadable
    for (const a of [bad, good]) await env.storage.putAttachment({ ...(await env.storage.getAttachment(a.local_attachment_id))!, state: 'queued', server_attachment_id: null, server_status: null });
    const realGet = env.storage.getAttachmentBlob;
    env.storage.getAttachmentBlob = async (id) => { if (id === bad.local_attachment_id) throw new Error('IDB exploded'); return realGet(id); };

    await q.kick();

    const badRow = (await env.storage.getAttachment(bad.local_attachment_id))!;
    expect(badRow.state).toBe('queued');
    expect(badRow.attempts).toBe(1);
    expect(badRow.last_error?.message).toContain('IDB exploded');
    expect((await env.storage.getAttachment(good.local_attachment_id))?.state).toBe('uploaded');
  });
});

describe('per-item Retry on an item that is backing off after a server error', () => {
  it('sends it again immediately (no wait for the 2 s+ backoff) and clears the old error once it succeeds', async () => {
    env.sessions.set('local-1', 'srv-1');
    env.api.failNext(500, 'S3 wrapper bug');
    const q = env.newQueue();
    const a = await q.add(photo());
    await q.whenIdle();
    const before = (await env.storage.getAttachment(a.local_attachment_id))!;
    expect(before).toMatchObject({ state: 'queued', attempts: 1 });
    expect(before.last_error).toMatchObject({ status: 500 });

    await q.retry(a.local_attachment_id);          // clock NOT advanced
    await q.whenIdle();

    expect(await env.storage.getAttachment(a.local_attachment_id)).toMatchObject({ state: 'uploaded', attempts: 0, last_error: null });
  });
});


describe('the stored copy is verified before it is sent', () => {
  it('an unreadable or different local copy fails locally with an explicit message — nothing is sent', async () => {
    env.sessions.set('local-1', 'srv-1');
    env.online.v = false;
    const q = env.newQueue();
    const a = await q.add(photo());
    // the file-backed Blob lost its data: same size claimed, different/empty bytes
    await env.storage.putAttachment({ ...(await env.storage.getAttachment(a.local_attachment_id))! }, new Blob(['\0\0\0\0']));
    env.online.v = true;

    await q.kick();

    const row = (await env.storage.getAttachment(a.local_attachment_id))!;
    expect(row.state).toBe('failed');
    expect(row.last_error?.message).toMatch(/Local copy unreadable or changed/);
    expect(env.api.uploadAttempts).toBe(0);
  });

  it('a blob that throws when read is reported the same way', async () => {
    env.sessions.set('local-1', 'srv-1');
    env.online.v = false;
    const q = env.newQueue();
    const a = await q.add(photo());
    const broken = { size: 4, type: 'image/jpeg', arrayBuffer: async () => { throw new Error('NotReadableError'); } } as unknown as Blob;
    env.storage.getAttachmentBlob = async () => broken;
    env.online.v = true;

    await q.kick();

    expect(await env.storage.getAttachment(a.local_attachment_id)).toMatchObject({ state: 'failed' });
    expect(env.api.uploadAttempts).toBe(0);
  });
});
