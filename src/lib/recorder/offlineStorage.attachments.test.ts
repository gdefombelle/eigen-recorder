/**
 * DB v1 → v2 migration. A v1 database already holds recorded audio: upgrading
 * must ADD the attachment stores and leave the audio stores alone — recreating
 * them would throw (store exists) and lose the recordings.
 */

import { describe, it, expect, vi } from 'vitest';

let upgradeFn: ((db: unknown, oldVersion: number) => void) | null = null;
vi.mock('idb', () => ({
  openDB: (_name: string, _version: number, opts: { upgrade: (db: unknown, old: number) => void }) => {
    upgradeFn = opts.upgrade;
    return Promise.resolve({ get: vi.fn(), put: vi.fn(), getAll: vi.fn().mockResolvedValue([]), close: vi.fn() });
  },
}));

import { offlineStorage } from './offlineStorage';

function fakeDb() {
  const created: string[] = [];
  const indexes: string[] = [];
  return {
    created, indexes,
    createObjectStore: (name: string) => { created.push(name); return { createIndex: (i: string) => indexes.push(`${name}:${i}`) }; },
  };
}

describe('offlineStorage upgrade', () => {
  it('fresh install (v0) creates the audio stores and the attachment stores', async () => {
    await offlineStorage.getAllSessions();
    const db = fakeDb();
    upgradeFn!(db, 0);
    expect(db.created).toEqual(['sessions', 'chunks_meta', 'chunks_data', 'attachments_meta', 'attachments_data']);
    expect(db.indexes).toContain('attachments_meta:by-session');
  });

  it('v1 → v2 only adds the attachment stores; recorded audio stores are untouched', async () => {
    await offlineStorage.getAllSessions();
    const db = fakeDb();
    upgradeFn!(db, 1);
    expect(db.created).toEqual(['attachments_meta', 'attachments_data']);
  });
});
