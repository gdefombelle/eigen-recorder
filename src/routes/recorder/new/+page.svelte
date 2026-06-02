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
  .page { flex: 1; display: flex; flex-direction: column; max-width: 480px; margin: 0 auto; width: 100%; }
</style>
