<script lang="ts">
  import SessionCreateLocal from '$lib/components/SessionCreateLocal.svelte';
  import { goto } from '$app/navigation';
</script>

<svelte:head><title>New Session — Eigen Recorder</title></svelte:head>

<main>
  <div class="page">
    <div class="content">
      <SessionCreateLocal on:cancel={() => goto('/recorder')} />
    </div>
  </div>
</main>

<style>
  main { flex: 1; display: flex; flex-direction: column; background: var(--ev-black); }
  .page {
    flex: 1;
    display: flex;
    flex-direction: column;
    max-width: 480px;
    margin: 0 auto;
    width: 100%;
    position: relative; /* needed for absolute-centered brand */
  }
  .content {
    padding: 0 var(--sp-4) var(--sp-8);
    display: flex;
    flex-direction: column;
    flex: 1;
  }
</style>
