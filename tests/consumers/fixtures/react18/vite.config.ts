import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { consumerConfig } from '../vite.base.ts';

const react18 = fileURLToPath(new URL('../../react18/node_modules/', import.meta.url)).split('\\').join('/');

export default defineConfig(consumerConfig({ worker: { format: 'es' }, resolve: { alias: [{ find: /^(react|react-dom)(\/.*)?$/, replacement: `${react18}$1$2` }] } }));
