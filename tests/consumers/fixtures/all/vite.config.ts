import { defineConfig } from 'vite';
import { consumerConfig } from '../vite.base.ts';

export default defineConfig(consumerConfig({ optimizeDeps: { include: ['mp4box', 'mediabunny'] } }));
