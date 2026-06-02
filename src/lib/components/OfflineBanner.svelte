<script lang="ts">
  export let visible: boolean = true;
</script>

{#if visible}
  <div class="offline-banner animate-fade-in">
    <span class="icon">📡</span>
    <span>Working offline — audio saved locally</span>
  </div>
{/if}

<style>
  .offline-banner {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-5);
    background: #1a0a00;
    border-bottom: 1px solid var(--orange);
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--orange);
    letter-spacing: 0.04em;
  }
  .icon { font-size: 0.85rem; }
</style>
