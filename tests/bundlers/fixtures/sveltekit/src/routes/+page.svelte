<script>
  import { onMount } from 'svelte';
  import { lazyProbe } from 'video-fps-probe/lazy';

  onMount(() => {
    window.__probe = lazyProbe();
  });
</script>

<input id="file" type="file" />
