import { defineConfig } from 'vitest/config';

/**
 * Integración contra un MySQL de verdad (el del docker-compose del proyecto por
 * defecto). Cada corrida crea bases `fiscal_it_*` desechables y las borra al
 * terminar: nunca toca `fiscal_ec_db` ni ninguna otra.
 *
 *   docker compose up -d mysql
 *   npm run test:integration
 *
 * Otro servidor: TEST_DB_HOST / TEST_DB_PORT / TEST_DB_USER / TEST_DB_PASSWORD.
 * Se usa 127.0.0.1 y no `localhost` a propósito: en esta máquina `localhost`
 * resuelve a ::1, donde escucha el MySQL de Windows, no el de Docker.
 */
const dbName = `fiscal_it_${Date.now()}`;
process.env.FISCAL_IT_DB = dbName;

const db = {
  DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1',
  DB_PORT: process.env.TEST_DB_PORT ?? '3306',
  DB_USER: process.env.TEST_DB_USER ?? 'root',
  DB_PASSWORD: process.env.TEST_DB_PASSWORD ?? 'root123',
};
Object.assign(process.env, { FISCAL_IT_HOST: db.DB_HOST, FISCAL_IT_PORT: db.DB_PORT, FISCAL_IT_USER: db.DB_USER, FISCAL_IT_PASSWORD: db.DB_PASSWORD });

export default defineConfig({
  test: {
    include: ['src/__tests__/integration/**/*.int.test.ts'],
    globalSetup: ['src/__tests__/integration/global-setup.ts'],
    // Comparten servidor y los de migraciones crean/borran bases: en serie.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
    env: { ...db, DB_NAME: dbName, NODE_ENV: 'test' },
  },
});
