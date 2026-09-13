# fiscal-ecuador

Emite ante el SRI de Ecuador las facturas que emite billing-service: arma el XML
(factura v2.1.0), lo firma con XAdES-BES, lo envía a recepción y consulta la
autorización hasta tener el comprobante autorizado.

## Flujo

```
billing.invoice.issued ──▶ validar ──▶ clave de acceso ──▶ XML ──▶ firma ──▶ recepción SRI
                                                                              │
                              ┌───────────────────────────────────────────────┤
                              ▼                                               ▼
                  RECIBIDA / "clave registrada"                          DEVUELTA
                   status=sent, next_check_at                         status=rejected
                              │
                  job cada 60 s (backoff por factura)
                              │
             ┌────────────────┼─────────────────┐
             ▼                ▼                 ▼
        AUTORIZADO      NO AUTORIZADO    EN PROCESAMIENTO / fallo SRI
     status=authorized  status=rejected   retry_count+1, backoff
     guarda XML oficial                   (a las 30 consultas: error)
```

Cada cambio de estado publica `fiscal.ec.invoice.<estado>` en el outbox, en la
misma transacción, con `requiresAttention: true` cuando hace falta una persona.
`billing.invoice.voided` publica `fiscal.ec.invoice.void_requires_action`.

## Estados

| Estado | Significa | Qué pasa después |
|---|---|---|
| `pending` | Firmada, enviándose | Si queda así más de 10 min (el proceso murió), el job la retoma |
| `sent` | El SRI la recibió | El job consulta la autorización con backoff (15 s, 2 min, 4 min… hasta 1 h) |
| `authorized` | Autorizada | Terminal. `authorized_xml_file_id` es el comprobante legal |
| `rejected` | Devuelta o no autorizada | Terminal. Hay que corregir y emitir otra factura |
| `error` | No se pudo completar | Con `next_check_at`: fallo de red/SRI, se reintenta solo (hasta 10). Sin él: error de datos o certificado, reintento manual con `POST /fiscal-invoices/:id/retry` |

## Decisiones que conviene no deshacer

- **La clave de acceso es estable por factura.** El código numérico sale de un
  hash del id de billing, no de `Math.random`: reenviar da "clave ya registrada"
  (se trata como recibida) en vez de crear otro comprobante con el mismo secuencial.
- **Se valida antes de enviar** (`domain/invoice-validation.ts`): cuadre de
  líneas, impuestos y totales, RUC, secuencial, tope de consumidor final. Un
  error de datos no se reintenta solo.
- **Nada se adivina.** Un impuesto que no es IVA, un código de IVA desconocido o
  un IVA 0% sin catálogo (0%, exento o no objeto) paran la factura con un
  mensaje, en vez de salir como IVA 15%.
- **Fechas en hora de Ecuador** (`domain/ecuador-time.ts`). El pod corre en UTC.
- **Un SOAP Fault es un error reintentable**, no un rechazo.
- **La firma se escribe en forma canónica** (exc-c14n). `xml-signer.test.ts` la
  verifica con `xml-crypto`, una implementación XMLDSig independiente.

## Configuración

| Variable | Por defecto | Notas |
|---|---|---|
| `SRI_ENVIRONMENT` | `pruebas` | `produccion` cambia el dígito de ambiente **y** las URLs (cel.sri.gob.ec). En k8s sale del ConfigMap `fiscal-config`, clave `sriEnvironment` |
| `SRI_RECEPTION_URL` / `SRI_AUTHORIZATION_URL` | las del ambiente | Solo para un simulador. Si contradicen el ambiente, el servicio no arranca |
| `SRI_TIMEOUT_MS` | `30000` | Tiempo máximo por llamada al SRI |
| `CERTIFICATE_MASTER_KEY` | valor de desarrollo | Cifra las contraseñas de los .p12. En producción avisa si es el de desarrollo |
| `INTERNAL_SERVICE_SECRET` | valor de desarrollo | Tiene que coincidir con el de document-service |
| `DOCUMENT_SERVICE_URL`, `TAX_SERVICE_URL`, `ORG_SERVICE_URL` | | Nombres de Service del clúster |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | | Si está, exporta trazas (precargado con `--import`, ver `src/instrumentation.ts`) |

Datos tributarios opcionales del emisor, en `organization.settings`:
`obligadoContabilidad` (bool), `contribuyenteRimpe`, `contribuyenteEspecial`,
`agenteRetencion`, `dirMatriz`, `defaultPaymentMethodCode`. Se editan en
Ajustes → Organización.

## API

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/fiscal-invoices?status=&page=&pageSize=` | `fiscal:read` |
| GET | `/fiscal-invoices/:billingInvoiceId` | `fiscal:read` |
| GET | `/fiscal-invoices/:id/xml` (id fiscal) | `fiscal:read` |
| GET | `/fiscal-invoices/:id/xml/download` | `fiscal:read` |
| POST | `/fiscal-invoices/:billingInvoiceId/retry` | `fiscal:manage` |
| GET/POST | `/certificates` | `fiscal:manage` |
| GET/DELETE | `/certificates/:id` | `fiscal:manage` |

## Desarrollo y tests

```bash
npm run dev               # migra y arranca con recarga
npm test                  # unitarios: sin red, sin base, sin SRI
npm run test:integration  # MySQL real (docker compose up -d mysql): migraciones y repositorios
npm run typecheck
```

`test:integration` crea bases `fiscal_it_*` desechables y las borra al terminar.
Encontró un fallo que los dobles en memoria no podían ver: `upsert` en MySQL
pisaba la fila de otra factura con el mismo número.

End-to-end (en `frontend/`, con el docker-compose levantado y el frontend en
:5173 apuntando a `http://localhost:8080`):

```bash
npx playwright test e2e/specs/sri-emision.spec.ts e2e/specs/seguridad-documentos.spec.ts
```

`sri-emision` crea su propia organización, emite contra el **SRI de pruebas**
(celcer) con un certificado autofirmado (`scripts/make-test-p12.mjs`) y valida
el XML, la tarjeta de estado, el reintento y la anulación. Con un RUC inventado
el SRI la devuelve por "contribuyente no registrado", y ese es el único rechazo
que el test acepta. `SRI_E2E_RUC=<ruc registrado>` exige que la reciba.

Los tests marcados `FALLO CONOCIDO` (`it.fails` / `test.fail`) pasan mientras el
fallo exista; cuando se arregle, fallarán y hay que quitar la marca.

## Pendiente

Ver `FACTURACION-BRECHAS.md` en la raíz del proyecto: RIDE (PDF), notas de
crédito, validación contra el XSD oficial y contra el validador del SRI.
