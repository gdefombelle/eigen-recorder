/**
 * Tests for UploadQueueStatus display logic.
 *
 * Focus: backup_only chunks must NOT count in the sync denominator,
 * and state='synced'|'mock_synced' must trigger the "✓ Synced" badge.
 *
 * The WebSocket / audio stream is intentionally NOT tested here — no
 * transport code is imported.  Tests cover display logic only.
 */

import { describe, it, expect } from 'vitest';
import type { AudioChunkMetadata } from '$lib/recorder/types';
import { deriveUploadQueue } from './uploadQueueStatus.logic';

// ── helpers ─────────────────────────────────────────────────────────────────

function chunk(
  status: AudioChunkMetadata['status'],
  id = Math.random().toString(36).slice(2),
): AudioChunkMetadata {
  return {
    local_chunk_id:   id,
    local_session_id: 'session-1',
    chunk_index:      0,
    start_ms:         0,
    end_ms:           30_000,
    mime_type:        'audio/webm',
    size_bytes:       500_000,
    saved_at:         new Date().toISOString(),
    uploaded_at:      null,
    status,
  };
}

// ── backup_only exclusion ────────────────────────────────────────────────────

describe('backup_only chunk — excluded from sync denominator', () => {
  it('1 backup_only → 0/0, not 0/1', () => {
    const { realChunks, uploaded } = deriveUploadQueue(
      [chunk('backup_only')],
      'stopped_local',
    );
    expect(realChunks.length).toBe(0);
    expect(uploaded).toBe(0);
    // The component only renders "X/Y synced" when realChunks.length > 0,
    // so this state produces NO sync counter — the key regression check.
  });

  it('1 real chunk not yet uploaded → 0/1', () => {
    const { realChunks, uploaded, pending } = deriveUploadQueue(
      [chunk('saved')],
      'stopped_local',
    );
    expect(realChunks.length).toBe(1);
    expect(uploaded).toBe(0);
    expect(pending).toBe(1);
  });

  it('1 real chunk uploaded → 1/1', () => {
    const { realChunks, uploaded, pending } = deriveUploadQueue(
      [chunk('uploaded')],
      'mock_synced',
    );
    expect(realChunks.length).toBe(1);
    expect(uploaded).toBe(1);
    expect(pending).toBe(0);
  });

  it('1 real chunk in progress + 1 backup → denominator is 1, not 2', () => {
    const { realChunks, uploaded } = deriveUploadQueue(
      [chunk('saved'), chunk('backup_only')],
      'stopped_local',
    );
    expect(realChunks.length).toBe(1);
    expect(uploaded).toBe(0);
  });

  it('1 uploaded real chunk + 1 backup → 1/1', () => {
    const { realChunks, uploaded } = deriveUploadQueue(
      [chunk('uploaded'), chunk('backup_only')],
      'mock_synced',
    );
    expect(realChunks.length).toBe(1);
    expect(uploaded).toBe(1);
  });
});

// ── isSynced badge ───────────────────────────────────────────────────────────

describe('isSynced — ✓ badge conditions', () => {
  it('state=synced → isSynced true  (POST /stop confirmed, PCM stream mode)', () => {
    const { isSynced } = deriveUploadQueue([], 'synced');
    expect(isSynced).toBe(true);
  });

  it('state=mock_synced → isSynced true  (offline flush complete)', () => {
    const { isSynced } = deriveUploadQueue([], 'mock_synced');
    expect(isSynced).toBe(true);
  });

  it('state=stopped_local → isSynced false  (POST /stop failed or not called)', () => {
    const { isSynced } = deriveUploadQueue([], 'stopped_local');
    expect(isSynced).toBe(false);
  });

  it('state=mock_uploading → isUploading true, isSynced false', () => {
    const { isSynced, isUploading } = deriveUploadQueue([], 'mock_uploading');
    expect(isSynced).toBe(false);
    expect(isUploading).toBe(true);
  });
});

// ── PCM stream post-stop scenario (the bug that triggered this fix) ─────────

describe('Record Now voice_note after stop — the 0/1 regression', () => {
  it('1 backup_only + state=synced → isSynced, no sync counter', () => {
    const result = deriveUploadQueue([chunk('backup_only')], 'synced');

    // The badge must show "✓ Synced"
    expect(result.isSynced).toBe(true);

    // The counter must NOT be rendered (realChunks.length === 0)
    expect(result.realChunks.length).toBe(0);

    // No pending warning
    expect(result.pending).toBe(0);

    // "0/1 synced" is impossible: realChunks.length = 0 → guard in template
    // prevents rendering the stat row.
  });

  it('1 backup_only + state=stopped_local → no badge, no counter', () => {
    // POST /stop failed — session not confirmed by backend.
    const result = deriveUploadQueue([chunk('backup_only')], 'stopped_local');
    expect(result.isSynced).toBe(false);
    expect(result.realChunks.length).toBe(0);
    expect(result.pending).toBe(0);
    // UI shows nothing for sync — correct, audio may or may not be on backend.
  });
});

// ── Pending warning ──────────────────────────────────────────────────────────

describe('pending warning — only for real chunks with status=saved', () => {
  it('only backup_only chunks → pending = 0, no warning shown', () => {
    const { pending } = deriveUploadQueue(
      [chunk('backup_only'), chunk('backup_only')],
      'stopped_local',
    );
    expect(pending).toBe(0);
  });

  it('1 saved real chunk → pending = 1, warning shown', () => {
    const { pending } = deriveUploadQueue([chunk('saved')], 'stopped_local');
    expect(pending).toBe(1);
  });

  it('mixed: saved + uploaded + backup_only → pending = 1', () => {
    const { pending, uploaded, realChunks } = deriveUploadQueue(
      [chunk('saved'), chunk('uploaded'), chunk('backup_only')],
      'stopped_local',
    );
    expect(pending).toBe(1);
    expect(uploaded).toBe(1);
    expect(realChunks.length).toBe(2);
  });
});
