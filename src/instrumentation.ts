/**
 * Telemetría (trazas) hacia el collector del clúster, igual que el resto de
 * servicios. El deployment ya declaraba las variables OTEL_* pero no había ni
 * una dependencia instalada, así que no se exportaba nada.
 *
 * Diferencia con tax-service y los demás: este servicio es ESM. Las
 * instrumentaciones parchean los módulos al cargarse, así que el SDK tiene que
 * estar arrancado antes de que se importe nada de la app. En ESM los imports
 * estáticos de main.ts se resuelven antes de ejecutar su primera línea, por lo
 * que no se puede garantizar desde dentro: se precarga con
 * `node --import ./dist/instrumentation.js dist/main.js` (ver Dockerfile), y el
 * hook de import-in-the-middle cubre los paquetes ESM.
 *
 * Verificado el 2026-09-13 con un receptor OTLP local: con --import llegan las
 * trazas de las peticiones HTTP.
 */
import { register } from 'node:module';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

  const [{ NodeSDK }, { resourceFromAttributes }, { OTLPTraceExporter }, { HttpInstrumentation }, { MySQL2Instrumentation }] =
    await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/instrumentation-http'),
      import('@opentelemetry/instrumentation-mysql2'),
    ]);

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME ?? 'fiscal-ecuador',
      'service.version': process.env.OTEL_SERVICE_VERSION ?? '1.0.0',
      'deployment.environment': process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    instrumentations: [new HttpInstrumentation(), new MySQL2Instrumentation()],
  });

  sdk.start();

  const shutdown = async (): Promise<void> => {
    try {
      await sdk.shutdown();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
