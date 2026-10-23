import { defineConfig } from 'vite';
import { consumerConfig } from '../vite.base.ts';

export default defineConfig(consumerConfig({ worker: { format: 'es' }, optimizeDeps: { include: ['mediabunny'] } }));
