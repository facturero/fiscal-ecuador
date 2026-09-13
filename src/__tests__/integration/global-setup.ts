import { connect, createDatabase, dropDatabase, sequelizeCli } from './db.js';

/**
 * Base compartida por los tests de repositorios: migrada entera, como en un
 * despliegue. Los tests de migraciones crean las suyas.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const name = process.env.FISCAL_IT_DB!;

  try {
    const conn = await connect();
    await conn.end();
  } catch (err) {
    throw new Error(
      `No hay MySQL en ${process.env.FISCAL_IT_HOST}:${process.env.FISCAL_IT_PORT} (${(err as Error).message}). ` +
        'Levanta el del proyecto con `docker compose up -d mysql`.',
    );
  }

  await createDatabase(name);
  await sequelizeCli(name, 'db:migrate');

  return async () => {
    await dropDatabase(name);
  };
}
