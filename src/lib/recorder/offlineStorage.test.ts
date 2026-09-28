/**
 * Tests for offlineStorage's connection handling.
 *
 * Regression guard for "Failed to execute 'transaction' on 'IDBDatabase': The
 * database connection is closing." On iOS, WebKit closes IndexedDB connections
 * while the app is suspended. The module cached the connection forever, so the
 * handle stayed dead and EVERY later read or write threw until the app was
 * force-quit — including saveChunk(), i.e. recorded audio could be lost.
 *
 * idb is mocked so the exact WebKit failure can be reproduced on demand.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type FakeDb = {
  put:   ReturnType<typeof vi.fn>;
  get:   ReturnType<typeof vi.fn>;
  getAll: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

const openDBMock = vi.fn();
vi.mock('idb', () => ({ openDB: (...args: unknown[]) => openDBMock(...args) }));

function closingError(): DOMException {
  return new DOMException(
    "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
    'InvalidStateError',
  );
}

function makeDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    put:    vi.fn().mockResolvedValue(undefined),
    get:    vi.fn().mockResolvedValue(undefined),
    getAll: vi.fn().mockResolvedValue([]),
    close:  vi.fn(),
    ...overrides,
  };
}

// The module holds the connection in module state — load a fresh copy per test.
async function loadStorage() {
  vi.resetModules();
  return import('./offlineStorage');
}

const SESSION = { local_session_id: 's1', title: 'Note' } as never;

beforeEach(() => {
  openDBMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('offlineStorage — dead connection recovery', () => {
  it('reopens and retries when the browser has closed the connection', async () => {
    const dead  = makeDb({ put: vi.fn().mockRejectedValue(closingError()) });
    const fresh = makeDb();
    openDBMock.mockResolvedValueOnce(dead).mockResolvedValueOnce(fresh);
    const { offlineStorage, dbReopenCount } = await loadStorage();

    await offlineStorage.saveSession(SESSION);

    expect(openDBMock).toHaveBeenCalledTimes(2);
    expect(fresh.put).toHaveBeenCalledWith('sessions', SESSION);
    expect(dbReopenCount()).toBe(1);
  });

  it('closes the dead handle instead of leaking it', async () => {
    const dead = makeDb({ put: vi.fn().mockRejectedValue(closingError()) });
    openDBMock.mockResolvedValueOnce(dead).mockResolvedValueOnce(makeDb());
    const { offlineStorage } = await loadStorage();

    await offlineStorage.saveSession(SESSION);
    await Promise.resolve();

    expect(dead.close).toHaveBeenCalled();
  });

  it('keeps working afterwards — the next call reuses the fresh connection', async () => {
    const dead  = makeDb({ getAll: vi.fn().mockRejectedValue(closingError()) });
    const fresh = makeDb({ getAll: vi.fn().mockResolvedValue([]) });
    openDBMock.mockResolvedValueOnce(dead).mockResolvedValueOnce(fresh);
    const { offlineStorage } = await loadStorage();

    await offlineStorage.getAllSessions();
    await offlineStorage.getAllSessions();

    expect(openDBMock).toHaveBeenCalledTimes(2); // not a reopen per call
  });

  it('reopens when the browser signals termination via idb\'s terminated() callback', async () => {
    openDBMock.mockResolvedValue(makeDb());
    const { offlineStorage } = await loadStorage();

    await offlineStorage.getAllSessions();
    expect(openDBMock).toHaveBeenCalledTimes(1);

    const options = openDBMock.mock.calls[0][2] as { terminated: () => void };
    options.terminated();
    await offlineStorage.getAllSessions();

    expect(openDBMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry unrelated errors — those are real failures', async () => {
    const constraint = new DOMException('duplicate key', 'ConstraintError');
    const db = makeDb({ put: vi.fn().mockRejectedValue(constraint) });
    openDBMock.mockResolvedValue(db);
    const { offlineStorage, dbReopenCount } = await loadStorage();

    await expect(offlineStorage.saveSession(SESSION)).rejects.toBe(constraint);

    expect(openDBMock).toHaveBeenCalledTimes(1);
    expect(dbReopenCount()).toBe(0);
  });

  it('gives up after ONE retry rather than looping if the fresh connection is dead too', async () => {
    const dead1 = makeDb({ put: vi.fn().mockRejectedValue(closingError()) });
    const dead2 = makeDb({ put: vi.fn().mockRejectedValue(closingError()) });
    openDBMock.mockResolvedValueOnce(dead1).mockResolvedValueOnce(dead2);
    const { offlineStorage } = await loadStorage();

    await expect(offlineStorage.saveSession(SESSION)).rejects.toMatchObject({ name: 'InvalidStateError' });

    expect(openDBMock).toHaveBeenCalledTimes(2);
  });
});

describe('offlineStorage — opening the connection', () => {
  it('opens once for concurrent first callers, not once each', async () => {
    openDBMock.mockResolvedValue(makeDb());
    const { offlineStorage } = await loadStorage();

    await Promise.all([
      offlineStorage.getAllSessions(),
      offlineStorage.getAllSessions(),
      offlineStorage.getTotalStorageBytes(),
    ]);

    expect(openDBMock).toHaveBeenCalledTimes(1);
  });

  it('a failed open does not poison later calls', async () => {
    openDBMock.mockRejectedValueOnce(new Error('quota')).mockResolvedValueOnce(makeDb());
    const { offlineStorage } = await loadStorage();

    await expect(offlineStorage.getAllSessions()).rejects.toThrow('quota');
    await expect(offlineStorage.getAllSessions()).resolves.toEqual([]);
  });
});
