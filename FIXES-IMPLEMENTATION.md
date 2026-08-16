# fiscal-ecuador — Correcciones pendientes (post-auditoría)

> **Para el agente (opencode):** este documento corrige la implementación anterior de `fiscal-ecuador` (ver `IMPLEMENTATION.md` en esta misma carpeta para el contexto original). Los primeros 3 puntos son **bloqueantes** — sin ellos, ninguna factura llega a autorizarse nunca. Seguí el orden.

---

## 1. 🔴 El certificado nunca se lee de verdad

**Problema:** en `src/infrastructure/messaging/consumer.ts`, se busca el `CertificateModel` de la organización pero después se ignora — se llama a `signXmlWithP12(unsignedXml, Buffer.alloc(0), '')` con un buffer vacío y contraseña vacía.

### 1.1 Descifrado de la contraseña

- [ ] Nuevo archivo `src/infrastructure/crypto/certificate-crypto.ts`:
  ```ts
  import crypto from 'node:crypto';

  const ALGORITHM = 'aes-256-gcm';

  export function encryptPassword(plainPassword: string, masterKey: string): string {
    const key = crypto.createHash('sha256').update(masterKey).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plainPassword, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // formato guardado: iv:authTag:ciphertext, todo en base64
    return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
  }

  export function decryptPassword(encryptedPassword: string, masterKey: string): string {
    const [ivB64, authTagB64, dataB64] = encryptedPassword.split(':');
    const key = crypto.createHash('sha256').update(masterKey).digest();
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }
  ```

### 1.2 Descarga del `.p12` desde document-service

- [ ] Nuevo método en `src/infrastructure/http/document-storage.ts` (o archivo nuevo `document-fetcher.ts`): `downloadFile(fileId: string): Promise<Buffer>` — `GET ${DOCUMENT_SERVICE_URL}/files/:id/download` con la cabecera `X-Internal-Secret` (mismo secreto que ya usa el upload). Si esa ruta de document-service exige auth de usuario normal en vez de aceptar el secreto interno, agregar ahí también el soporte para `X-Internal-Secret` como alternativa válida (mismo patrón que `internalAuthMiddleware()` que ya existe para el upload).

### 1.3 Conectar todo en el consumer

- [ ] En `handleInvoiceIssued`, **antes** de llamar a `signXmlWithP12`:
  ```ts
  const p12Buffer = await documentFetcher.downloadFile(certificate.p12_file_id);
  const password = decryptPassword(certificate.password_encrypted, config.CERTIFICATE_MASTER_KEY);
  const { signedXml, certificateSerial } = signXmlWithP12(unsignedXml, p12Buffer, password);
  ```
- [ ] Si `p12_file_id` no existe o la descarga falla: factura a `status: 'error'`, `last_error: 'No se pudo leer el certificado'` — no reventar el proceso completo.

---

## 2. 🔴 Falta `POST /certificates`

- [ ] En `src/interface/http/app.ts`, agregar (mismo patrón multipart que `POST /files/internal` de document-service):
  ```ts
  r.post('/certificates',
    requireOrganization(),
    requirePermission('fiscal:manage'),
    async (c) => {
      const orgId = c.get('organizationId');
      const body = await c.req.parseBody();
      const file = body['file'] as File;
      const password = body['password'] as string;
      const alias = (body['alias'] as string) || 'Certificado';

      if (!file || !password) return c.json({ code: 'BadRequestError', message: 'Falta el archivo .p12 o la contraseña' }, 400);

      const buffer = Buffer.from(await file.arrayBuffer());

      // Validar que la contraseña efectivamente abre el .p12 ANTES de guardar nada
      // (usar node-forge acá mismo, igual que en xml-signer.ts, solo para validar — no firmar nada)
      try {
        validateP12Password(buffer, password); // nueva función en xml-signer.ts o un helper compartido
      } catch {
        return c.json({ code: 'BadRequestError', message: 'La contraseña no corresponde al certificado, o el archivo no es un .p12 válido' }, 400);
      }

      const { validFrom, validUntil } = extractP12Validity(buffer, password); // extraer notBefore/notAfter del certificado X.509

      const uploaded = await documentStorage.upload({
        resourceId: orgId, category: 'certificado',
        originalName: file.name, mimeType: 'application/x-pkcs12', buffer,
      });

      const encryptedPassword = encryptPassword(password, config.CERTIFICATE_MASTER_KEY);

      const cert = await CertificateModel.create({
        id: randomUUID(), organization_id: orgId, alias,
        p12_file_id: uploaded.fileId, password_encrypted: encryptedPassword,
        valid_from: validFrom, valid_until: validUntil, status: 'active',
        created_at: new Date(),
      });

      return c.json(toCertificateDTO(cert)); // SIN password_encrypted, ver punto 9
    },
  );
  ```
- [ ] `documentStorage.upload()` necesita devolver el `fileId` real de la respuesta de document-service (revisar que el método actual lo devuelva; si solo devuelve `void`, ajustarlo).

---

## 3. 🔴 Reescribir la firma XAdES-BES correctamente

**Problema:** usa `UnsignedProperties` en vez de `SignedProperties`, el único `<ds:Reference>` no cubre el contenido de la factura, `CertDigest` calcula mal (usa el hash del XML completo en vez del hash del certificado), `X509IssuerName` queda vacío.

- [ ] Reescribir `src/domain/xml-signer.ts` con la estructura XAdES-BES correcta — **dos referencias** en `SignedInfo`:
  1. Referencia al documento: `URI="#comprobante"` (coincide con `id="comprobante"` del `<factura>`), transform enveloped-signature + C14N, digest del **documento completo**.
  2. Referencia a `SignedProperties`: `Type="http://uri.etsi.org/01903#SignedProperties"`, `URI="#xadesSignedProperties"`, digest del **XML de `SignedProperties` serializado**.
  - `SignedProperties` (no `UnsignedProperties`) contiene `SigningTime` + `SigningCertificate` (con `CertDigest` = **hash del certificado DER**, no del documento) + `IssuerSerial` con `X509IssuerName` real (`certificate.issuer.attributes`, forge lo expone) y `X509SerialNumber`.
  - El bloque `<ds:Object><xades:QualifyingProperties Target="#<idDeLaFirma>"><xades:SignedProperties Id="xadesSignedProperties">...` — usar `Target`, no un atributo inventado `QualifyingProperties=`.
- [ ] **Antes de dar esto por bueno**, validar el XML firmado resultante con una herramienta de validación XAdES (o al menos con `xmllint` contra el esquema de firma XML-DSig `xmldsig-core-schema.xsd` + el esquema XAdES `XAdES.xsd`, ambos públicos) — no asumir que compila solo porque no tira excepción en runtime.
- [ ] Si existe código de `invoice-plugin` reusable, priorizar adaptarlo sobre reescribir esto a mano otra vez — ya se avisó dos veces, la firma es la pieza de mayor riesgo de todo el proyecto.

---

## 4. 🟡 `NO_OBJETO` vs `IVA 0%` — usar el código de la tasa, no el porcentaje

- [ ] Nuevo puerto en fiscal-ecuador (mismo patrón que `HttpTaxRateCatalog` de billing-service): `TaxRateCatalogPort.findByCountry(countryCode): Promise<{id, code, percentage, kind}[]>`, contra `GET ${TAX_SERVICE_URL}/countries/:code/tax-rates`.
- [ ] En el consumer, antes de armar el XML: resolver cada `taxRateId` de `payload.lines[].taxes[]` contra esa lista y obtener su `code` (`IVA0`, `IVA15`, `NO_OBJETO`).
- [ ] En `invoice-xml-builder.ts`, cambiar `mapIvaCode(rateSnapshot)` por `mapIvaCode(taxCode)`:
  ```ts
  const CODE_MAP: Record<string, string> = { IVA0: '0', IVA15: '4', NO_OBJETO: '6' };
  ```
- [ ] Agregar `TAX_SERVICE_URL` a la config de fiscal-ecuador (default `http://tax-service:3005`).

---

## 5. 🟡 `obligadoContabilidad` hardcodeado

- [ ] `organization-service` ya tiene una columna `settings` (JSON) en `organizations` — no hace falta migración nueva. Agregar el campo `obligadoContabilidad: boolean` dentro de ese JSON, editable desde `OrganizationSettingsView.vue` (un checkbox más en el formulario de perfil fiscal).
- [ ] `HttpOrganizationCatalog.getOrganization()` (en fiscal-ecuador) ya trae la respuesta completa de `GET /organizations/me` — agregar `obligadoContabilidad: org.settings?.obligadoContabilidad ?? false` al `IssuerInfo` que devuelve.
- [ ] En `invoice-xml-builder.ts`, usar ese valor real en vez de `'SI'` fijo.

---

## 6. 🟡 `tipoIdentificacionComprador` por regex → resolver contra tax-service

- [ ] Mismo `TaxRateCatalogPort`-style: agregar `findIdentificationTypes(countryCode)` contra `GET /countries/:code/identification-types` (si la ruta no existe en tax-service, revisar — puede que el catálogo de tipos de identificación viva en customer-service en vez de tax-service; confirmar contra el código real antes de asumir).
- [ ] Resolver `customer.identificationTypeId` (que ya viene en el payload) contra ese catálogo, mapear su `code` (`RUC`, `CEDULA`, `PASAPORTE`, `CONSUMIDOR_FINAL`, `EXTERIOR`) a los códigos del SRI (`04`, `05`, `06`, `07`, `08`).
- [ ] Dejar el regex actual como *fallback* únicamente si la resolución contra el catálogo falla (no borrar del todo, por resiliencia), pero ya no como método principal.

---

## 7. 🟡 Publicar los eventos `fiscal.ec.invoice.*`

- [ ] En cada transición de estado del consumer y del job de reconciliación (`sent`, `rejected`, `error`, `authorized`), agregar un `OutboxModel.create(...)` con `type: 'fiscal.ec.invoice.<estado>'` — mismo patrón que ya usa `billing-service` en `issue-invoice.ts`. El `OutboxRelay` que ya está arrancado en `main.ts` se encarga de publicarlos, no hace falta tocar nada más ahí.

---

## 8. 🟡 El endpoint de retry no reintenta nada

- [ ] Agregar columna `original_payload` (JSON) a `fiscal_invoices` (nueva migración) — guardar ahí el `payload` completo del evento la primera vez que se procesa.
- [ ] `POST /fiscal-invoices/:id/retry` debe leer ese `original_payload` y volver a llamar a la misma lógica de `handleInvoiceIssued` directamente (extraer esa función para que sea invocable tanto desde el consumer como desde el controlador REST), no solo cambiar el `status` en la base.

---

## 9. 🟡 No exponer `password_encrypted`

- [ ] Nuevo `toCertificateDTO(cert)` en `application/` (o donde corresponda) que devuelva `{ id, alias, validFrom, validUntil, status, createdAt }` — sin `password_encrypted` ni `p12_file_id` siquiera (no hace falta exponer el file id tampoco). Usar este DTO en `GET /certificates` y en la respuesta de `POST /certificates`.

---

## 10. 🟢 Validar la clave de acceso contra un caso real

- [ ] Buscar un ejemplo de clave de acceso pública y validada (documentación oficial del SRI, o casos de prueba de librerías open source equivalentes como `open-factura` en npm/GitHub) y agregar un test que reconstruya esa clave exacta con `buildAccessKey()` usando los mismos datos de entrada, comparando el resultado completo (no solo longitud/formato).

---

## Orden sugerido

1 → 2 → 3 (bloqueantes, en ese orden — sin 1 y 2 no hay nada que firmar; sin 3, lo que se firme no sirve) → 4, 5, 6 (correctitud del contenido) → 7, 8, 9 (operatividad) → 10 (confianza en el algoritmo ya escrito).

Después de esto, recién ahí tiene sentido probar contra el ambiente de pruebas del SRI con un certificado y RUC de pruebas reales.
