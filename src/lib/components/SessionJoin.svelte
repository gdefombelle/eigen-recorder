<script lang="ts">
  // SessionJoin — placeholder for future backend-joined sessions.
  // Will accept a session code / QR scan to join a live room from eigenvertex-app.
  import { createEventDispatcher } from 'svelte';

  const dispatch = createEventDispatcher<{ cancel: void }>();

  let code = '';
</script>

<div class="join-panel animate-slide-up">
  <div class="join-header">
    <button class="btn btn-ghost btn-sm" on:click={() => dispatch('cancel')}>← Back</button>
    <h2>Join Session</h2>
  </div>

  <div class="card join-card">
    <div class="coming-soon">
      <div class="cs-icon">🔗</div>
      <h3>Coming soon</h3>
      <p>
        Join a live Eigen Meeting room from a session code or QR scan.<br />
        This requires a connected EigenVertex backend.
      </p>
      <div class="form-field" style="margin-top: var(--sp-5);">
        <label for="join-code">Session Code</label>
        <input
          id="join-code"
          class="input"
          type="text"
          bind:value={code}
          placeholder="XXXX-XXXX"
          disabled
        />
      </div>
      <button class="btn btn-primary btn-full" disabled>Join</button>
    </div>
  </div>
</div>

<style>
  .join-panel { display: flex; flex-direction: column; gap: var(--sp-5); }
  .join-header { display: flex; align-items: center; gap: var(--sp-3); }
  .join-header h2 { flex: 1; }

  .coming-soon {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-3);
    text-align: center;
    padding: var(--sp-4) 0;
    width: 100%;
  }
  .cs-icon { font-size: 2.5rem; }
  .coming-soon h3 { color: var(--text-dim); }
  .coming-soon p  { font-size: 0.875rem; }
</style>
