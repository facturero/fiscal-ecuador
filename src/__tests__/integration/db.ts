import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';

const ROOT = resolve(import.meta.dirname, '../../..');

export interface ServerOptions {
  host: string;
  port: number;
  user: string;
  password: string;
}

export function serverFromEnv(): ServerOptions {
  return {
    host: process.env.FISCAL_IT_HOST ?? process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.FISCAL_IT_PORT ?? process.env.DB_PORT ?? 3306),
    user: process.env.FISCAL_IT_USER ?? process.env.DB_USER ?? 'root',
    password: process.env.FISCAL_IT_PASSWORD ?? process.env.DB_PASSWORD ?? 'root123',
  };
}

/** Solo se crean y borran bases con este prefijo: es la garantía de no tocar datos reales. */
const PREFIX = 'fiscal_it_';

function assertDisposable(name: string): void {
  if (!name.startsWith(PREFIX) || !/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`Base "${name}" no es desechable: los tests solo manejan bases ${PREFIX}*`);
  }
}

export async function connect(database?: string): Promise<mysql.Connection> {
  return mysql.createConnection({ ...serverFromEnv(), database, multipleStatements: false });
}

export async function createDatabase(name: string): Promise<void> {
  assertDisposable(name);
  const conn = await connect();
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await conn.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await conn.end();
  }
}

export async function dropDatabase(name: string): Promise<void> {
  assertDisposable(name);
  const conn = await connect();
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
  } finally {
    await conn.end();
  }
}

/**
 * Corre sequelize-cli tal como lo hace el initContainer de k8s, con las
 * migraciones reales del repo. `args` extra: `['--to', 'x.cjs']`, etc.
 */
export async function sequelizeCli(database: string, command: string, args: string[] = []): Promise<string> {
  assertDisposable(database);
  const server = serverFromEnv();
  const cli = resolve(ROOT, 'node_modules/sequelize-cli/lib/sequelize');
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, command, '--config', 'sequelize.config.cjs', ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        DB_HOST: server.host,
        DB_PORT: String(server.port),
        DB_USER: server.user,
        DB_PASSWORD: server.password,
        DB_NAME: database,
      },
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => {
      if (code === 0) resolvePromise(output);
      else reject(new Error(`sequelize-cli ${command} ${args.join(' ')} falló (${code}):\n${output}`));
    });
  });
}

export interface ColumnInfo {
  COLUMN_NAME: string;
  IS_NULLABLE: 'YES' | 'NO';
  COLUMN_TYPE: string;
}

export async function columns(database: string, table: string): Promise<Record<string, ColumnInfo>> {
  const conn = await connect();
  try {
    const [rows] = await conn.query(
      'SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [database, table],
    );
    return Object.fromEntries((rows as ColumnInfo[]).map((r) => [r.COLUMN_NAME, r]));
  } finally {
    await conn.end();
  }
}

export async function indexes(database: string, table: string): Promise<Array<{ name: string; unique: boolean; columns: string[] }>> {
  const conn = await connect();
  try {
    const [rows] = await conn.query(
      `SELECT INDEX_NAME, NON_UNIQUE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) cols
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        GROUP BY INDEX_NAME, NON_UNIQUE`,
      [database, table],
    );
    return (rows as Array<{ INDEX_NAME: string; NON_UNIQUE: number; cols: string }>).map((r) => ({
      name: r.INDEX_NAME,
      unique: Number(r.NON_UNIQUE) === 0,
      columns: r.cols.split(','),
    }));
  } finally {
    await conn.end();
  }
}
