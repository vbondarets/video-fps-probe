<script setup>
import { onMounted } from 'vue';
import { lazyProbe } from 'video-fps-probe/lazy';

onMounted(() => {
  window.__probe = lazyProbe();
});
</script>

<template>
  <input id="file" type="file" />
</template>
