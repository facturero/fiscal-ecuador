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

## Nota de débito, retención y guía de remisión (Fase 1.4 del plan ERP)

Construido y verificado en local, **sin desplegar**. Cada comprobante se valida contra su XSD oficial del SRI en CI (`test-resources/sri-xsd/`): nota de débito v1.0.0, comprobante de retención v2.0.0 y guía de remisión v1.1.0.

| Comprobante | Quién lo origina | Numeración |
|---|---|---|
| Nota de débito (05) | **billing** (`POST /invoices/:id/debit-note`); fiscal la recibe por `billing.invoice.issued` con `documentTypeCode: '05'` | la de billing (serie propia del tipo 05) |
| Retención (07) | **fiscal** (`POST /fiscal/withholdings`, permiso `withholding:issue`) | `fiscal_sequences` (serie 07 por organización + establecimiento + punto) |
| Guía de remisión (06) | **fiscal** (`POST /fiscal/delivery-guides`, permiso `delivery_guide:issue`) | `fiscal_sequences` (serie 06) |

**Cómo funciona lo propio de fiscal.** `DirectDocumentIssuer` valida los datos, resuelve al emisor en organization-service (`HttpIssuerDirectory`), **reserva el número y crea el registro en una sola transacción** (`INSERT … ON DUPLICATE KEY UPDATE` + `SELECT … FOR UPDATE`; 30 emisiones simultáneas dan 30 números seguidos sin interbloqueos) y entrega el comprobante al mismo procesador que las facturas (`signAndSend`: certificado, firma XAdES, recepción, autorización, reintentos, huecos de secuencia). El registro va en `fiscal_invoices` con `source = 'fiscal'` y `billing_invoice_id` = su propio id; `original_payload` guarda el comprobante completo (sin él no hay reintento ni RIDE). El reintento y el trabajo de reconciliación despachan por tipo (`FiscalInvoiceProcessor.retry`).

**Datos que no son del cliente.** Lo retenido (`base × porcentaje`, mitad hacia arriba, con enteros) lo calcula el servidor; el cliente nunca manda `valorRetenido`. Se rechaza antes de reservar número: base mayor que el subtotal (renta), que el IVA (IVA) o que el total (ISD); total del sustento que no es subtotal + impuestos; traslado que empieza antes de hoy; porcentaje con más de tres cifras (límite del esquema).

**Evento contable.** Al **autorizarse** una retención se publica `fiscal.ec.withholding.issued` (renta, IVA e ISD retenidos, proveedor y sustento; sin datos de contacto). `accounting-service` lo asienta: Dr proveedores / Cr retenciones por pagar. Una retención que se crea pero no se autoriza no genera asiento.

**RIDE** propio de cada tipo (`direct-ride-pdf.ts`), solo para comprobantes autorizados. Listado: `GET /fiscal-invoices?document_type=07&source=fiscal` (con `summary`; el detalle trae el `payload`). Catálogos de apoyo para los formularios: `GET /fiscal/withholding-codes`.

**Límites conocidos.**
- Solo pagos **locales** en la retención (`pagoLocExt = 01`): los pagos al exterior exigen régimen, país y convenio de doble tributación.
- Los códigos de retención y de sustento que ofrece el formulario son una **ayuda** (`direct-documents.ts`): la tabla oficial cambia por resolución; el sistema no impide otro código y el SRI lo valida al recibir. Que un contador la revise antes de producción.
- No se detecta una segunda retención sobre el mismo comprobante de sustento del mismo proveedor (el SRI sí las acepta distintas).
- No hay anulación de retenciones ni guías desde el CRM: se anulan en SRI en línea.
- Como todo el servicio, nada se ha autorizado jamás por el SRI real: falta RUC y certificado acreditado.

## Pendiente

Ver `FACTURACION-BRECHAS.md` en la raíz del proyecto: RIDE (PDF), notas de
crédito, validación contra el XSD oficial y contra el validador del SRI.
