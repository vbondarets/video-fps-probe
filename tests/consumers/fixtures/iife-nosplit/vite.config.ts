import { defineConfig } from 'vite';
import { consumerConfig } from '../vite.base.ts';

export default defineConfig(consumerConfig({ worker: { format: 'iife', rolldownOptions: { output: { codeSplitting: false } } } }));
