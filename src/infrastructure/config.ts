import 'dotenv/config';
import { z } from 'zod';

/**
 * Endpoints de los web services "offline" del SRI por ambiente. Antes solo
 * existían los de pruebas (celcer): pasar `SRI_ENVIRONMENT` a `produccion`
 * cambiaba el dígito de ambiente del XML pero seguía mandando a celcer, que
 * rechaza cualquier comprobante de producción.
 */
export const SRI_ENDPOINTS = {
  pruebas: {
    reception: 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline',
    authorization: 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline',
  },
  produccion: {
    reception: 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline',
    authorization: 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline',
  },
} as const;

const DEV_INTERNAL_SECRET = 'dev-internal-secret-change-me';
const DEV_CERT_MASTER_KEY = 'dev-cert-master-key-change-me';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3010),

  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default('secret'),
  DB_NAME: z.string().default('fiscal_ec_db'),

  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  RABBITMQ_URL: z.string().optional(),

  DOCUMENT_SERVICE_URL: z.string().default('http://document-service:3007'),
  INTERNAL_SERVICE_SECRET: z.string().default(DEV_INTERNAL_SECRET),

  TAX_SERVICE_URL: z.string().default('http://tax-service:3005'),
  ORG_SERVICE_URL: z.string().default('http://organization-service:3002'),

  SRI_ENVIRONMENT: z.enum(['pruebas', 'produccion']).default('pruebas'),
  // Vacías = las del ambiente. Solo para apuntar a un simulador o a un proxy.
  SRI_RECEPTION_URL: z.string().optional(),
  SRI_AUTHORIZATION_URL: z.string().optional(),
  SRI_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  CERTIFICATE_MASTER_KEY: z.string().default(DEV_CERT_MASTER_KEY),
});

export type Env = Omit<z.infer<typeof envSchema>, 'SRI_RECEPTION_URL' | 'SRI_AUTHORIZATION_URL'> & {
  SRI_RECEPTION_URL: string;
  SRI_AUTHORIZATION_URL: string;
};

/**
 * Resuelve la configuración y se niega a arrancar en producción con lo que no
 * debe llegar nunca a producción. Exportada por separado para poder probarla.
 */
export function resolveConfig(source: NodeJS.ProcessEnv): { env?: Env; problems: string[]; warnings: string[] } {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    return { problems: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), warnings: [] };
  }

  const data = parsed.data;
  const endpoints = SRI_ENDPOINTS[data.SRI_ENVIRONMENT];
  const env: Env = {
    ...data,
    SRI_RECEPTION_URL: data.SRI_RECEPTION_URL || endpoints.reception,
    SRI_AUTHORIZATION_URL: data.SRI_AUTHORIZATION_URL || endpoints.authorization,
  };

  const problems: string[] = [];
  const warnings: string[] = [];
  if (env.NODE_ENV === 'production') {
    // En producción no se arranca con los valores de desarrollo del repo: con
    // la clave maestra de ejemplo las contraseñas de los .p12 quedan cifradas
    // con una clave pública, y con el secreto de ejemplo las rutas internas de
    // document-service quedan abiertas. Producción los tuvo así hasta el
    // 2026-09-13; desde entonces la clave sale de secrets.production.enc
    // (rotada) y el secreto del secret compartido `internal-service-secret`.
    if (env.CERTIFICATE_MASTER_KEY === DEV_CERT_MASTER_KEY) {
      problems.push('CERTIFICATE_MASTER_KEY tiene el valor de desarrollo: las contraseñas de los certificados no estarían protegidas');
    }
    if (env.INTERNAL_SERVICE_SECRET === DEV_INTERNAL_SECRET) {
      problems.push('INTERNAL_SERVICE_SECRET tiene el valor de desarrollo: las rutas internas de document-service quedarían abiertas');
    }
  }
  // Mezclar ambiente y endpoint produce comprobantes que el SRI rechaza siempre.
  const pointsToTest = /celcer\.sri\.gob\.ec/.test(env.SRI_RECEPTION_URL) || /celcer\.sri\.gob\.ec/.test(env.SRI_AUTHORIZATION_URL);
  const pointsToProd = /\/\/cel\.sri\.gob\.ec/.test(env.SRI_RECEPTION_URL) || /\/\/cel\.sri\.gob\.ec/.test(env.SRI_AUTHORIZATION_URL);
  if (env.SRI_ENVIRONMENT === 'produccion' && pointsToTest) {
    problems.push('SRI_ENVIRONMENT es produccion pero las URLs del SRI apuntan a celcer (pruebas)');
  }
  if (env.SRI_ENVIRONMENT === 'pruebas' && pointsToProd) {
    problems.push('SRI_ENVIRONMENT es pruebas pero las URLs del SRI apuntan a cel (producción)');
  }

  return { env: problems.length ? undefined : env, problems, warnings };
}

let _env: Env | undefined;

export function loadConfig(): Env {
  if (!_env) {
    const { env, problems, warnings } = resolveConfig(process.env);
    for (const warning of warnings) console.error(`[fiscal-ecuador] INSEGURO: ${warning}`);
    if (!env) {
      console.error('Configuración inválida:');
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    _env = env;
  }
  return _env;
}

export const config = loadConfig();
