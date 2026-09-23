import { defineConfig } from 'vitest/config';
import { webConfig } from '../../vite.shared.ts';

export default defineConfig(webConfig({ port: 5174 }));
