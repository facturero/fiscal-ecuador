# fiscal-ecuador — Implementación (Fase 2 de facturación)

> **Para el agente (opencode):** este documento reemplaza y concreta el diseño ya existente en `Documents/sg-obs/crm-proyect/servicios/fiscal-ecuador.md` (léelo primero, es el diseño de alto nivel) y en `Documents/sg-obs/crm-proyect/arquitectura/estrategia-multipais.md` (la decisión de por qué es un servicio separado por país, no un módulo genérico — léelo también, ahí está el razonamiento completo). Este documento es la especificación técnica para construirlo. Sigue las fases en orden. Imita las convenciones ya usadas en el resto del monorepo (Hono, Sequelize, Clean Architecture, Outbox/relay, consumer con `processed_events`) — ver `billing-service` y `organization-service` como referencia de estilo.
>
> **Alcance de este documento:** clave de acceso, XML real del SRI (factura v2.1.0), firma XAdES-BES, envío y autorización vía los web services SOAP del SRI. **No incluye** el RIDE (PDF con QR) — eso es un documento aparte, posterior a este.
>
> **Aislamiento (no negociable, ya está en el diseño original):** billing-service **no sabe que este servicio existe**. Si el SRI está caído, billing sigue facturando comercialmente sin verse afectado. Este servicio consume `billing.invoice.issued` de forma completamente asíncrona (mismo exchange `crm.events`, mismo patrón que ya usa el consumer de documentos en billing-service).
>
> **Anti-patrones explícitos a evitar (copiados literal de `estrategia-multipais.md`, no son sugerencias):**
> 1. **No** agregar ningún campo de estado fiscal (`authorization_number`, etc.) a las tablas de `billing_db`. El estado fiscal vive única y exclusivamente en `fiscal_ec_db`, referenciando `billing_invoice_id`.
> 2. **No** hacer que billing-service llame a fiscal-ecuador por HTTP en ningún punto del flujo de emisión. Todo pasa por el evento `billing.invoice.issued` vía RabbitMQ. Si fiscal-ecuador necesita datos que no vinieron en el evento, se resignan (no se hace un GET sincrónico a billing-service).
> 3. **No** construir esto como un "servicio fiscal genérico" pensando en reusarlo para otros países después — es explícitamente `fiscal-ecuador`, con lógica 100% de Ecuador adentro. Cuando llegue Perú/Colombia/México, cada uno es un servicio nuevo, no una rama de este.
> 4. **No** hacer que billing-service (ni ningún otro servicio) cachee o lea el estado fiscal desde fiscal-ecuador. Quien necesite saber si una factura ya fue autorizada por el SRI escucha `fiscal.ec.invoice.authorized` directamente (o consulta la API de fiscal-ecuador), nunca a través de billing.

---

## 0. Prerrequisito: `documentTypeId` no es estable hoy

Antes de tocar nada de esto, hay que resolver algo que va a romper la resolución del código de comprobante (`01` = factura) para el XML.

- `tax-service/migrations/20260705120001-seed-ecuador.js` genera los IDs de `document_types` con `randomUUID()` **en cada corrida del seed** — igual que el bug que ya encontramos antes con `tax_rates` (que sí se corrigió ahí, pero acá no).
- El frontend (`InvoiceFormView.vue`) manda un `documentTypeId` **hardcodeado**: `'00000000-0000-4000-a000-000000000010'`. Ese UUID no tiene ninguna relación con lo que el seed genera — no corresponde a ninguna fila real de `document_types` a menos que coincida por pura casualidad.
- Hoy esto no rompe nada visible porque `billing-service` nunca valida `documentTypeId` contra `tax-service` — lo guarda a ciegas. Pero `fiscal-ecuador` sí necesita resolverlo a un `code` real (`01`) para el nodo `<codDoc>` del XML, así que si el ID no existe, todo esto se cae en el primer paso.

### 0.1 Arreglo

- [ ] Nueva migración en `tax-service` (mismo patrón que `20260707120000-add-organization-admin-permission.js` de auth-service: id determinístico, no aleatorio): asignar IDs fijos a los `document_types` de `EC`, por ejemplo `00000000-0000-4000-b000-000000000001` (código `01`), `...002` (código `04`), etc. — o más simple: usar un hash determinístico del código igual que hicimos para los permisos (`md5('EC:01')` truncado a UUID).
- [ ] Actualizar el `documentTypeId` hardcodeado del frontend para que coincida con el nuevo ID fijo de `01` (o, mejor a mediano plazo: que el frontend llame a `GET /countries/EC/document-types` y elija dinámicamente el de código `01`, en vez de hardcodear cualquier UUID — es la misma clase de arreglo que ya hicimos con establecimientos/puntos de emisión).
- [ ] Confirmar con un query directo que, tras migrar, `SELECT id FROM document_types WHERE country_code='EC' AND code='01'` da el mismo ID que ahora manda el frontend.

---

## 0.2 Segundo prerrequisito: el payload del evento no trae el secuencial "crudo"

Revisé el payload real que arma `issue-invoice.ts` al publicar `billing.invoice.issued`. Trae `number` ya formateado como string para mostrar (`"001-001-000000001"`) y `issuerSnapshot.establishmentCode`/`issuerSnapshot.emissionPointCode` (esos sí son los códigos de 3 dígitos limpios, confirmado contra `organization-service` que los genera con `padStart(3, '0')`). Pero **no** trae el secuencial de 9 dígitos como campo separado — solo dentro del string ya armado con guiones.

Parsear `number.split('-')[2]` para sacar el secuencial funciona hoy, pero es frágil: si alguna vez cambia el formato de despliegue de `number` (separadores, orden), rompe la clave de acceso en silencio.

- [ ] En `billing-service/src/application/use-cases/issue-invoice.ts`, agregar al payload del evento un campo explícito `sequentialNumber` (el `seqFormatted` que ya se calcula ahí mismo, antes de armar el `number` con guiones):
  ```ts
  payload: {
    invoiceId: invoice.id,
    number: invoice.number,
    sequentialNumber: seqFormatted, // NUEVO — el secuencial de 9 dígitos suelto, sin formatear
    organizationId: invoice.organizationId,
    countryCode: invoice.countryCode,
    // ...resto igual
  }
  ```
- [ ] `fiscal-ecuador` arma la clave de acceso con `establishmentCode`/`emissionPointCode` desde `payload.issuerSnapshot` y `sequentialNumber` desde el campo nuevo — sin parsear ningún string formateado.

---

## 1. Scaffold del servicio

- [ ] Nuevo directorio `backend/fiscal-ecuador/`, mismo esqueleto que `billing-service` (Hono, `@hono/node-server`, Sequelize + mysql2, Zod, TypeScript strict, Clean Architecture `domain/application/infrastructure/interface`).
- [ ] Base de datos propia: `fiscal_ec_db`. Agregar `CREATE DATABASE IF NOT EXISTS fiscal_ec_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;` a `docker/mysql/init.sql` (mismo patrón que las 8 bases que ya están ahí), y el bloque `fiscal-migrate` + `fiscal-ecuador` en `docker-compose.yml` (copiar el bloque de `billing-migrate`/`billing-service` y ajustar nombres/puertos/env).
- [ ] `package.json`: agregar `node-forge` (firma XAdES-BES, mismo enfoque que ya usaste en `invoice-plugin`), `soap` o `strong-soap` (cliente SOAP para consumir los WSDL del SRI — evaluar cuál tiene mejor soporte para WS-Security/adjuntos binarios; si ninguno sirve bien, construir el sobre SOAP a mano con `fetch` y XML plano, es perfectamente viable dado que solo son 2 operaciones), `xml-crypto` o firma manual (ver 5.2), `amqplib`, `dotenv`.

---

## 2. Modelo de datos (`fiscal_ec_db`)

Migración inicial, siguiendo el ERD ya diseñado en `fiscal-ecuador.md`:

```js
await queryInterface.createTable('fiscal_invoices', {
  id: { type: Sequelize.CHAR(36), primaryKey: true },
  organization_id: { type: Sequelize.CHAR(36), allowNull: false },
  billing_invoice_id: { type: Sequelize.CHAR(36), allowNull: false, unique: true },
  number: { type: Sequelize.STRING(30), allowNull: false },
  access_key: { type: Sequelize.CHAR(49), allowNull: false, unique: true },
  status: { type: Sequelize.ENUM('pending', 'sent', 'authorized', 'rejected', 'error'), allowNull: false, defaultValue: 'pending' },
  authorization_number: { type: Sequelize.STRING(49), allowNull: true },
  authorization_date: { type: Sequelize.DATE, allowNull: true },
  sri_response: { type: Sequelize.JSON, allowNull: true },
  signed_xml_file_id: { type: Sequelize.CHAR(36), allowNull: true },
  retry_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
  last_error: { type: Sequelize.TEXT, allowNull: true },
  created_at: { type: Sequelize.DATE, allowNull: false },
  updated_at: { type: Sequelize.DATE, allowNull: false },
});

await queryInterface.createTable('certificates', {
  id: { type: Sequelize.CHAR(36), primaryKey: true },
  organization_id: { type: Sequelize.CHAR(36), allowNull: false },
  alias: { type: Sequelize.STRING(100), allowNull: false },
  p12_file_id: { type: Sequelize.CHAR(36), allowNull: false }, // ref -> document-service, category="certificado", NUNCA is_public
  password_encrypted: { type: Sequelize.TEXT, allowNull: false }, // AES-256-GCM con clave maestra del servicio (env var, no en DB)
  valid_from: { type: Sequelize.DATEONLY, allowNull: false },
  valid_until: { type: Sequelize.DATEONLY, allowNull: false },
  status: { type: Sequelize.ENUM('active', 'expired', 'revoked'), allowNull: false, defaultValue: 'active' },
  created_at: { type: Sequelize.DATE, allowNull: false },
});
await queryInterface.addIndex('certificates', ['organization_id', 'status']);

await queryInterface.createTable('outbox_messages', { /* mismo shape que los demás servicios */ });
await queryInterface.createTable('processed_events', { /* mismo shape que billing-service */ });
```

- [ ] Hecho.

---

## 3. Consumer: `billing.invoice.issued` → arranca el flujo fiscal

- [ ] Mismo patrón que el consumer de documentos de billing-service: exchange `crm.events`, queue `fiscal-ecuador.invoices`, bind a `billing.invoice.issued`, idempotencia con `processed_events`.
- [ ] **Filtro por país explícito, igual que hicimos en billing-service**: si `payload.countryCode !== 'EC'`, `ack` y no hacer nada. Este servicio se llama `fiscal-ecuador` — nunca debe procesar facturas de otro país aunque el evento le llegue (el exchange es compartido). No asumir "si me llegó, es mío".
- [ ] Handler `handleInvoiceIssued`:
  1. Idempotencia (`processed_events`).
  2. Filtro de país (arriba).
  3. Busca el certificado activo de la organización (`certificates` donde `organization_id` + `status='active'` + `valid_until >= hoy`). Si no hay certificado, crea el `fiscal_invoices` en estado `error` con `last_error = 'Sin certificado activo'` y **no reintenta solo** (esto requiere que alguien suba un certificado — no es un error transitorio de red). Publica igual `fiscal.ec.invoice.error` para que se pueda mostrar en el front.
  4. Si hay certificado: continúa con las fases 4–7 de este documento.
- [ ] También consumir `billing.invoice.voided` (para el caso de anulación — ver sección 8, nota de crédito, marcado explícitamente fuera de alcance de esta primera implementación pero hay que al menos loguear que se recibió, no ignorarlo en silencio).

---

## 4. Clave de acceso (49 dígitos)

**Orden real de los campos** (confirmado contra la ficha técnica vigente del SRI, no asumido):

| # | Campo | Formato | Longitud |
|---|-------|---------|----------|
| 1 | Fecha de emisión | `ddmmaaaa` | 8 |
| 2 | Tipo de comprobante | `01` para factura | 2 |
| 3 | RUC del emisor | 13 dígitos | 13 |
| 4 | Tipo de ambiente | `1`=pruebas, `2`=producción | 1 |
| 5 | Serie | código establecimiento (3) + código punto de emisión (3) | 6 |
| 6 | Número secuencial | el número que ya asignó billing-service, sin guiones, con padding a 9 | 9 |
| 7 | Código numérico | aleatorio, 8 dígitos (no debe repetirse por comprobante) | 8 |
| 8 | Tipo de emisión | `1` (normal — en esquema offline es el único valor válido) | 1 |

Subtotal: 48 dígitos. Se le agrega:

| 9 | Dígito verificador | módulo 11 sobre los 48 dígitos anteriores | 1 |

**Total: 49 dígitos.**

### 4.1 Algoritmo módulo 11 (dígito verificador)

- [ ] Nuevo archivo `src/domain/access-key.ts`:
  ```ts
  function checkDigitMod11(digits48: string): string {
    const weights = [2, 3, 4, 5, 6, 7]; // se repiten cíclicamente
    let sum = 0;
    let weightIndex = 0;
    for (let i = digits48.length - 1; i >= 0; i--) {
      sum += parseInt(digits48[i], 10) * weights[weightIndex % weights.length];
      weightIndex++;
    }
    const mod = sum % 11;
    const result = 11 - mod;
    if (result === 11) return '0';
    if (result === 10) return '1';
    return String(result);
  }

  export function buildAccessKey(input: {
    issueDate: Date; documentTypeCode: string; issuerRuc: string;
    environment: 'pruebas' | 'produccion'; establishmentCode: string; emissionPointCode: string;
    sequentialNumber: string; // ya viene con padding a 9 desde billing
  }): string {
    const dd = String(input.issueDate.getDate()).padStart(2, '0');
    const mm = String(input.issueDate.getMonth() + 1).padStart(2, '0');
    const yyyy = String(input.issueDate.getFullYear());
    const fecha = `${dd}${mm}${yyyy}`;
    const ambiente = input.environment === 'produccion' ? '2' : '1';
    const serie = `${input.establishmentCode}${input.emissionPointCode}`;
    const codigoNumerico = String(Math.floor(Math.random() * 100000000)).padStart(8, '0');
    const tipoEmision = '1';

    const base48 = `${fecha}${input.documentTypeCode}${input.issuerRuc}${ambiente}${serie}${input.sequentialNumber}${codigoNumerico}${tipoEmision}`;
    if (base48.length !== 48) throw new Error(`Clave de acceso mal formada: ${base48.length} dígitos, se esperaban 48`);

    return base48 + checkDigitMod11(base48);
  }
  ```
- [ ] Test unitario con un ejemplo conocido (buscar uno público en la documentación del SRI o en `rsbmk-open-factura`/librerías open source equivalentes, para validar el dígito verificador contra un caso real, no solo contra la propia implementación).

---

## 5. XML de la factura (v2.1.0)

### 5.1 Estructura (validar campo por campo contra el XSD oficial antes de ir a producción)

La estructura general (estable entre versiones 1.0–2.1, con nodos adicionales en 2.1.0) es:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<factura id="comprobante" version="2.1.0">
  <infoTributaria>
    <ambiente>1</ambiente> <!-- 1=pruebas, 2=producción -->
    <tipoEmision>1</tipoEmision>
    <razonSocial>...</razonSocial>
    <nombreComercial>...</nombreComercial> <!-- opcional -->
    <ruc>...</ruc>
    <claveAcceso>...</claveAcceso> <!-- la de la sección 4 -->
    <codDoc>01</codDoc>
    <estab>001</estab>
    <ptoEmi>001</ptoEmi>
    <secuencial>000000001</secuencial>
    <dirMatriz>...</dirMatriz>
  </infoTributaria>
  <infoFactura>
    <fechaEmision>dd/mm/aaaa</fechaEmision>
    <dirEstablecimiento>...</dirEstablecimiento> <!-- opcional -->
    <obligadoContabilidad>SI</obligadoContabilidad> <!-- o NO -->
    <tipoIdentificacionComprador>...</tipoIdentificacionComprador> <!-- ver tabla SRI: 04 RUC, 05 Cédula, 06 Pasaporte, 07 Consumidor Final -->
    <razonSocialComprador>...</razonSocialComprador>
    <identificacionComprador>...</identificacionComprador>
    <totalSinImpuestos>...</totalSinImpuestos>
    <totalDescuento>0.00</totalDescuento>
    <totalConImpuestos>
      <totalImpuesto>
        <codigo>2</codigo> <!-- 2 = IVA -->
        <codigoPorcentaje>...</codigoPorcentaje> <!-- 0=0%, 2=12%, 3=14%, 4=15%, 6=No objeto, 7=Exento -->
        <baseImponible>...</baseImponible>
        <valor>...</valor>
      </totalImpuesto>
    </totalConImpuestos>
    <propina>0.00</propina>
    <importeTotal>...</importeTotal>
    <moneda>DOLAR</moneda>
  </infoFactura>
  <detalles>
    <detalle>
      <codigoPrincipal>...</codigoPrincipal>
      <descripcion>...</descripcion>
      <cantidad>...</cantidad>
      <precioUnitario>...</precioUnitario>
      <descuento>0.00</descuento>
      <precioTotalSinImpuesto>...</precioTotalSinImpuesto>
      <impuestos>
        <impuesto>
          <codigo>2</codigo>
          <codigoPorcentaje>...</codigoPorcentaje>
          <tarifa>...</tarifa>
          <baseImponible>...</baseImponible>
          <valor>...</valor>
        </impuesto>
      </impuestos>
    </detalle>
  </detalles>
  <infoAdicional>
    <campoAdicional nombre="email">...</campoAdicional>
  </infoAdicional>
</factura>
```

⚠️ **Antes de mandar el primer comprobante al ambiente de pruebas del SRI**, descargar el XSD real desde `https://www.sri.gob.ec/facturacion-electronica` (sección "Esquemas XSD Y XML Tipo de documento Factura") y validar el XML generado contra ese esquema con un validador XSD (`xmllint --schema factura_V2.1.0.xsd archivo.xml --noout`, o la librería `libxmljs2` en Node). Los nombres de nodo de arriba son correctos por documentación pública, pero el **orden exacto y la obligatoriedad de cada campo** hay que confirmarlos contra el XSD, no contra este documento.

- [ ] Mapeo de `codigoPorcentaje` de IVA: el `rate_snapshot` que ya calculamos en billing-service (15, 0) hay que mapearlo a los códigos de tabla del SRI (`4` = 15%, `0` = 0%, `6` = no objeto de IVA, `7` = exento). Este mapeo vive en `fiscal-ecuador`, no en billing (billing no necesita saber nada de códigos SRI).
- [ ] Nuevo archivo `src/domain/invoice-xml-builder.ts`, función pura que recibe el payload del evento + el certificado/RUC y arma el string XML sin firmar (similar en espíritu a `render-invoice-xml.ts` de billing-service, pero con el esquema real).

### 5.2 Firma XAdES-BES

**Esta es la parte de mayor riesgo técnico — no hay una librería Node madura y mantenida para XAdES-BES específico del SRI ecuatoriano.** Dado que ya resolviste esto antes en `invoice-plugin` con `node-forge`, el enfoque a replicar:

- [ ] Leer el `.p12` (contraseña desencriptada desde `certificates.password_encrypted`) con `node-forge` (`forge.pkcs12.pkcs12FromAsn1`), extraer clave privada + certificado X.509.
- [ ] Canonicalizar el XML (C14N) antes de firmar — usar `xml-crypto` para esto si su canonicalizador sirve standalone, o portar la lógica que ya tenías en `invoice-plugin`.
- [ ] Construir el bloque `<ds:Signature>` con la estructura XAdES-BES que exige el SRI (referencia al nodo `factura`, `SignedProperties`, certificado en `KeyInfo`). El Anexo 14 de la ficha técnica del SRI ("EJEMPLO FIRMA ELECTRONICA XADES-BES") trae un ejemplo completo — usarlo como plantilla de referencia exacta, no reinventar la estructura.
- [ ] **Recomendación fuerte:** si tenés acceso al código de `invoice-plugin`, traer ese módulo de firma casi literal en vez de reescribirlo — ya lo validaste contra el SRI real una vez, es la parte que menos conviene reinventar.
- [ ] Guardar el XML firmado en document-service (mismo endpoint interno `POST /files/internal` ya construido, `resourceType: 'fiscal_invoice'`, `category: 'comprobante-firmado'`), y el `file_id` en `fiscal_invoices.signed_xml_file_id`.

---

## 6. Envío y autorización (SOAP)

**Endpoints confirmados (verificados hoy, julio 2026):**

```
Pruebas:
  Recepción:    https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl
  Autorización: https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl

Producción:
  Recepción:    https://cel.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl
  Autorización: https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl
```

- [ ] Config nueva: `SRI_ENVIRONMENT` (`pruebas`|`produccion`), `SRI_RECEPTION_URL`, `SRI_AUTHORIZATION_URL` (con los defaults de arriba según ambiente).
- [ ] **Paso 1 — Recepción**: `validarComprobante(xml: base64)` → SOAP call a `RecepcionComprobantesOffline`. Respuesta esperada: `RECIBIDA` (pasó validación de esquema/firma básica) o `DEVUELTA` (rechazo inmediato, con lista de mensajes de error). Si `DEVUELTA`: `fiscal_invoices.status = 'rejected'`, guardar `sri_response` completo, publicar `fiscal.ec.invoice.rejected`, **no reintentar** (un rechazo de esquema no se arregla reintentando el mismo XML).
- [ ] **Paso 2 — Autorización**: si `RECIBIDA`, consultar `autorizacionComprobante(claveAccesoConsultada)` contra `AutorizacionComprobantesOffline`. El SRI puede tardar hasta 24h en el peor caso, aunque normalmente son minutos — **esto no se espera sincrónicamente**. Encolar una consulta de estado con backoff (ver 6.1).
- [ ] Dado que el SRI solo expone SOAP (no REST), construir el sobre SOAP con `fetch` + XML plano si las librerías `soap`/`strong-soap` dan problemas con este WSDL específico (es un patrón conocido — varias librerías Node tienen fricciones con los WSDL del SRI). No perder tiempo peleando con generación automática de stubs si a mano es más simple y controlable.

### 6.1 Job de reconciliación (consulta de autorización pendiente)

- [ ] Nuevo proceso recurrente (mismo proceso Node, un `setInterval`, no un cron externo — mantiene todo en un solo deploy): cada 2 minutos, buscar `fiscal_invoices` con `status = 'sent'` y consultar autorización. Si `AUTORIZADO`: guardar `authorization_number`, `authorization_date`, XML autorizado (el SRI lo devuelve firmado con su propio sello dentro del CDATA de la respuesta — ese es el que hay que guardar como definitivo, reemplazando el `signed_xml_file_id` original), `status = 'authorized'`, publicar `fiscal.ec.invoice.authorized`. Si `NO AUTORIZADO`/rechazado en esta etapa: `status = 'rejected'`, publicar `fiscal.ec.invoice.rejected`.
- [ ] Límite de reintentos razonable antes de marcar `error` definitivo y requerir intervención manual (ej. 30 intentos ≈ 1 hora de polling cada 2 min; si after eso sigue `sent`, algo anómalo pasa y no debe reintentarse indefinidamente en silencio — loguear con nivel de alerta).

---

## 7. API REST mínima (mismo formato que el resto de servicios)

| Método | Ruta | Permiso | Uso |
|---|---|---|---|
| GET | `/fiscal-invoices/:billingInvoiceId` | `fiscal:read` | Ver estado fiscal de una factura |
| POST | `/fiscal-invoices/:billingInvoiceId/retry` | `fiscal:manage` | Reintentar manualmente tras un `error` (ej. después de subir un certificado) |
| GET | `/fiscal-invoices/:id/xml` | `fiscal:read` | Descarga el XML autorizado (redirige a document-service) |
| POST | `/certificates` | `fiscal:manage` | Sube un `.p12` (multipart) + contraseña — la contraseña nunca se loguea ni se devuelve en ninguna respuesta |
| GET | `/certificates` | `fiscal:manage` | Lista certificados de la organización (sin exponer la contraseña) |
| DELETE | `/certificates/:id` | `fiscal:manage` | Revoca (marca `status: 'revoked'`, no borra físicamente — se necesita para auditoría) |

- [ ] Agregar los permisos `fiscal:read` y `fiscal:manage` al catálogo de auth-service (misma migración-patrón que ya usamos para `invoice:update`/`invoice:issue` — nuevo permiso + asignación a Administrador).
- [ ] Rutas expuestas vía gateway: agregar `{ method: 'ANY', path: '/fiscal-invoices/*', service: 'fiscal-ecuador' }` y `{ method: 'ANY', path: '/certificates/*', service: 'fiscal-ecuador' }` a `gateway.config.ts` (¡ojo! ya existe una ruta `/certificates` en el gateway — revisar que no choque con nada existente antes de agregarla, o usar un prefijo distinto como `/fiscal/certificates` si hay conflicto).

---

## 8. Explícitamente fuera de alcance de este documento

- **RIDE** (PDF con código de barras/QR de verificación) — documento siguiente, una vez esto esté autorizando comprobantes reales en el ambiente de pruebas del SRI.
- **Nota de crédito para anulación** de una factura ya autorizada — se consume `billing.invoice.voided` pero solo se loguea por ahora, no se genera el comprobante de anulación.
- **Comprobantes de retención, notas de débito, guías de remisión** — solo factura (`codDoc=01`) en esta fase.
- **Reintento automático de facturas rechazadas** — un rechazo requiere revisión humana (algo está mal en los datos o en la firma), no se reintenta el mismo XML solo.

---

## Checklist de aceptación final

1. Al emitir una factura en Ecuador desde el front, unos segundos después aparece un registro en `fiscal_invoices` con `status: 'pending'` → `'sent'`.
2. La clave de acceso generada pasa la validación módulo 11 (test unitario contra un caso conocido).
3. El XML generado valida contra el XSD oficial de factura v2.1.0 (`xmllint` u otra herramienta de validación XSD).
4. Con un certificado `.p12` de pruebas real y el RUC de pruebas correspondiente, el envío a `RecepcionComprobantesOffline` en el ambiente de **pruebas** del SRI devuelve `RECIBIDA` (no `DEVUELTA`).
5. La consulta de autorización eventualmente devuelve `AUTORIZADO` con un `authorization_number`, y `fiscal_invoices.status` pasa a `authorized`.
6. Si se emite una factura en un país que no sea `EC`, este servicio no hace absolutamente nada (ni siquiera intenta resolver certificado) — mismo principio de aislamiento por país que ya aplicamos en billing-service.
7. Si no hay certificado activo para la organización, la factura queda en `error` con un mensaje claro, sin reintentar indefinidamente, y billing-service sigue funcionando con total normalidad (la factura sigue `issued` comercialmente).
