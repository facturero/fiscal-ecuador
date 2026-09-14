# Esquemas XSD oficiales del SRI

Usados por `src/__tests__/xsd-validation.test.ts` para validar en CI el XML que
genera fiscal-ecuador contra el esquema real, no contra lo que dice la
documentación.

| Archivo | Origen | SHA-256 |
|---|---|---|
| `factura_V2.1.0.xsd` | SRI, "Esquemas XSD Y XML Tipo de documento Factura" (`XML y XSD Factura.zip`), <https://www.sri.gob.ec/facturacion-electronica>, descargado el 2026-09-13 | `5f2c37bc1a58bb40e8bbbc366cabe05d5dc199598aeea1561137370f8bd4eace` |
| `factura_V2.1.0.xml` | Mismo zip: el XML de ejemplo del SRI. El test lo valida primero para comprobar que la herramienta funciona | `c329f927b71044a6582b58bcabe7de80e7f4b2417375b77fec2fe9cde21dc39d` |
| `notaCredito_V1.1.0.xsd` | SRI, "Esquemas XSD Y XML Tipo de documento Nota de Crédito" (`nota_credito.zip`). El SRI mantiene la nota de crédito en versión 1.1.0 del esquema (la versión 2.1.0 es de factura). Espejo íntegro del contenido oficial en `cuymo/facturacion-electronica-ec` con hash coincidente con el manifest del mirror | `379e9f270d71ab4578f130a736c9abe5eb1d7969375ecdef55d2973583ec5ab0` |
| `xmldsig-core-schema.xsd` | W3C, <https://www.w3.org/TR/xmldsig-core/xmldsig-core-schema.xsd>. Los XSD del SRI lo importan y los zips no lo traen | `d102ad3df7664c307e0c2c776ba4a90513b1969974d8a940bae1a77f9f21e15d` |

Zip original del SRI: SHA-256 `ba1ff0c4e329fe759c3f88dc75f2975780b315b6eb3d0069071b77c1f26fec03`.

Si el SRI publica una versión nueva de la ficha técnica, descargar el zip otra
vez, sustituir los archivos y actualizar esta tabla.
