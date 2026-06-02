<script lang="ts">
  export let online: boolean;
</script>

<div class="conn-status" class:online class:offline={!online}>
  <span class="dot"></span>
  <span class="label">{online ? 'Online' : 'Offline'}</span>
</div>

<style>
  .conn-status {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 10px;
    border-radius: var(--r-full);
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    border: 1px solid;
    transition: all var(--t);
  }
  .online  { background: var(--green-dim); color: var(--green); border-color: var(--green); }
  .offline { background: var(--red-dim);   color: var(--red);   border-color: var(--red);   }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }
  .online .dot  { animation: pulse-dot 2s ease-in-out infinite; }
</style>
