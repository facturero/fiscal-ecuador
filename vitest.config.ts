import { defineConfig } from 'vitest/config';

// Tests unitarios: sin red, sin base de datos, sin SRI. Los de integración
// (MySQL real) y los end-to-end (stack levantado) tienen su propia config.
export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    exclude: ['src/__tests__/**/*.int.test.ts', 'src/__tests__/**/*.e2e.test.ts', 'node_modules/**', 'dist/**'],
  },
});
