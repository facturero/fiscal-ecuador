import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Coherencia de los manifiestos de k8s de la cadena de facturación.
 *
 * Cada servicio es su propio repo y nadie comprobaba que las URLs de un
 * deployment apuntaran a Services que existen: fiscal-ecuador llamaba a
 * `document-service-node:3007`, `tax-service-node` y
 * `organization-service-node`, que no existen, y nunca pudo bajar un
 * certificado. Estos tests leen los repos hermanos (`backend/*`); en un CI que
 * solo tenga este repo se saltan.
 */
const BACKEND = resolve(import.meta.dirname, '../../..');
const hasSiblings = existsSync(join(BACKEND, 'billing-service/k8s')) && existsSync(join(BACKEND, 'document-service/k8s'));

/** Los deployments cuyas llamadas forman la cadena de facturación. */
const BILLING_CHAIN = ['api-gateway-node', 'billing-service', 'fiscal-ecuador', 'document-service'];

/** Services definidos fuera de los repos de servicios (infra del clúster, comprobados con kubectl). */
const CLUSTER_INFRA = new Map([
  ['minio', ['9000']],
  ['rabbitmq', ['5672']],
  ['otel-collector.observability.svc.cluster.local', ['4318', '4317']],
]);

/**
 * Variables que se sabe que están mal pero no son de facturación. Cada una con
 * su motivo; no añadir sin él.
 */
const KNOWN_UNRELATED = new Set([
  // El Service del repo se llama inventory-service-node. Inventario no está
  // desplegado en el clúster (2026-09-13), así que hoy no rompe nada.
  'api-gateway-node:INVENTORY_SERVICE_URL',
]);

function readManifests(): Map<string, string[]> {
  const services = new Map<string, string[]>(CLUSTER_INFRA);
  for (const repo of readdirSync(BACKEND)) {
    const dir = join(BACKEND, repo, 'k8s');
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
      for (const doc of readFileSync(join(dir, file), 'utf8').split(/^---$/m)) {
        if (!/^kind:\s*Service\s*$/m.test(doc)) continue;
        const name = doc.match(/^metadata:\s*\n\s+name:\s*(\S+)/m)?.[1];
        const ports = [...doc.matchAll(/^\s*-?\s*port:\s*(\d+)/gm)].map((m) => m[1]);
        if (name) services.set(name, ports);
      }
    }
  }
  return services;
}

interface EnvVar {
  name: string;
  value?: string;
  secret?: string;
}

function envOf(repo: string): EnvVar[] {
  const file = join(BACKEND, repo, 'k8s/deployment.yaml');
  const text = readFileSync(file, 'utf8');
  const vars: EnvVar[] = [];
  const re = /-\s*name:\s*(\w+)\s*\n\s*(?:value:\s*"?([^"\n]*)"?|valueFrom:\s*\n\s*secretKeyRef:\s*\n\s*name:\s*(\S+)\s*\n\s*key:\s*(\S+))/g;
  for (const m of text.matchAll(re)) {
    vars.push({ name: m[1], value: m[2], secret: m[3] ? `${m[3]}/${m[4]}` : undefined });
  }
  return vars;
}

describe.skipIf(!hasSiblings)('Manifiestos k8s de la cadena de facturación', () => {
  const services = hasSiblings ? readManifests() : new Map<string, string[]>();

  it.each(BILLING_CHAIN)('%s: toda URL http interna apunta a un Service que existe y a su puerto', (repo) => {
    const broken = envOf(repo)
      .filter((v) => v.value?.startsWith('http://') && !KNOWN_UNRELATED.has(`${repo}:${v.name}`))
      .map((v) => {
        const url = new URL(v.value!);
        const ports = services.get(url.hostname);
        if (!ports) return `${v.name}=${v.value} (no existe el Service ${url.hostname})`;
        if (!ports.includes(url.port)) return `${v.name}=${v.value} (${url.hostname} expone ${ports.join(', ')})`;
        return null;
      })
      .filter(Boolean);
    expect(broken).toEqual([]);
  });

  it('el gateway enruta facturación y fiscal (sin estas variables /invoices da 500 SERVICE_NOT_FOUND)', () => {
    const names = envOf('api-gateway-node').map((v) => v.name);
    expect(names).toEqual(expect.arrayContaining(['BILLING_SERVICE_URL', 'FISCAL_SERVICE_URL']));
  });

  it('fiscal-ecuador no se expone fuera del clúster', () => {
    const service = readFileSync(join(BACKEND, 'fiscal-ecuador/k8s/service.yaml'), 'utf8');
    expect(service).toMatch(/type:\s*ClusterIP/);
  });

  /**
   * FACTURACION-BRECHAS.md, N5. document-service valida X-Internal-Secret contra
   * INTERNAL_SERVICE_SECRET, y quien lo llama tiene que mandar el mismo valor.
   * Hasta el 2026-09-13 document-service no definía la variable (valor de
   * desarrollo), fiscal la leía de `fiscal-db/internalSecret` (también de
   * desarrollo) y billing, auth y organization del secret real.
   */
  it('todos los servicios usan el mismo secreto interno, y ninguno un literal en el manifiesto', () => {
    const repos = readdirSync(BACKEND).filter((r) => existsSync(join(BACKEND, r, 'k8s/deployment.yaml')));
    const sources = Object.fromEntries(
      repos
        .map((repo) => [repo, envOf(repo).find((e) => e.name === 'INTERNAL_SERVICE_SECRET')] as const)
        .filter(([, v]) => v)
        .map(([repo, v]) => [repo, v!.secret ?? `literal:${v!.value}`]),
    );

    expect(Object.keys(sources)).toEqual(expect.arrayContaining(['document-service', 'billing-service', 'fiscal-ecuador']));
    expect(new Set(Object.values(sources)), JSON.stringify(sources)).toEqual(new Set(['internal-service-secret/value']));
  });

  it('fiscal-ecuador ya no crea un secreto interno propio en el despliegue', () => {
    const workflow = readFileSync(join(BACKEND, 'fiscal-ecuador/.github/workflows/deploy.yaml'), 'utf8');
    expect(workflow).not.toMatch(/internalSecret/);
  });
});
