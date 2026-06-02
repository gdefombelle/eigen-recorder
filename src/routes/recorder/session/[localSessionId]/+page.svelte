<script lang="ts">
  import { page } from '$app/stores';
  import RecorderMiniK7 from '$lib/components/RecorderMiniK7.svelte';

  $: localSessionId = $page.params.localSessionId ?? '';
</script>

<svelte:head>
  <title>Recording — Eigen Recorder</title>
</svelte:head>

<!-- Full-screen — no padding wrapper, RecorderMiniK7 owns the layout -->
<RecorderMiniK7 {localSessionId} />
