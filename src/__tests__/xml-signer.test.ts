import { describe, expect, it } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import { signXmlWithP12, extractP12Validity } from '../domain/xml-signer.js';
import { buildInvoiceXml } from '../domain/invoice-xml-builder.js';
import { selfSignedP12, sampleInvoice, TAX_CODES } from './fixtures.js';

function unsignedInvoice(): string {
  const payload = sampleInvoice();
  return buildInvoiceXml({
    payload,
    accessKey: '1309202601179217560600110010010000001231234567814',
    environment: 'pruebas',
    issueDate: new Date(payload.issueDate!),
    establishmentCode: '001',
    emissionPointCode: '001',
    sequentialNumber: payload.sequentialNumber,
    taxCodeById: TAX_CODES,
    identificationTypeCode: 'RUC',
  });
}

/**
 * La verificación la hace `xml-crypto`, una implementación de XMLDSig que no
 * tiene nada que ver con nuestro firmador: canonicaliza, aplica los transforms
 * y recalcula digests y firma como lo haría el SRI. No sustituye al validador
 * oficial, pero si esto falla, el SRI también la rechaza.
 */
describe('Firma XAdES-BES', () => {
  const p12 = selfSignedP12();

  it('produce una firma que un verificador XMLDSig independiente da por válida', () => {
    const { signedXml } = signXmlWithP12(unsignedInvoice(), p12.buffer, p12.password);

    const doc = new DOMParser().parseFromString(signedXml, 'text/xml');
    const signature = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')[0];
    expect(signature).toBeDefined();

    const verifier = new SignedXml({ publicCert: p12.certPem, getCertFromKeyInfo: () => null });
    verifier.loadSignature(signature as unknown as Node);
    const valid = verifier.checkSignature(signedXml);

    expect(valid).toBe(true);
  });

  it('una factura modificada después de firmar ya no valida', () => {
    const { signedXml } = signXmlWithP12(unsignedInvoice(), p12.buffer, p12.password);
    const tampered = signedXml.replace('<importeTotal>28.00</importeTotal>', '<importeTotal>2.80</importeTotal>');

    const doc = new DOMParser().parseFromString(tampered, 'text/xml');
    const signature = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')[0];
    const verifier = new SignedXml({ publicCert: p12.certPem, getCertFromKeyInfo: () => null });
    verifier.loadSignature(signature as unknown as Node);

    let valid: boolean;
    try {
      valid = verifier.checkSignature(tampered);
    } catch {
      valid = false;
    }
    expect(valid).toBe(false);
  });

  it('la firma queda dentro de <factura>, justo antes del cierre', () => {
    const { signedXml } = signXmlWithP12(unsignedInvoice(), p12.buffer, p12.password);
    expect(signedXml).toMatch(/<\/ds:Signature><\/factura>$/);
  });

  it('una contraseña equivocada no firma', () => {
    expect(() => signXmlWithP12(unsignedInvoice(), p12.buffer, 'otra')).toThrow();
  });

  it('lee la vigencia del certificado', () => {
    const dated = selfSignedP12({ notBefore: new Date('2026-01-10T12:00:00Z'), notAfter: new Date('2027-01-10T12:00:00Z') });
    expect(extractP12Validity(dated.buffer, dated.password)).toEqual({ validFrom: '2026-01-10', validUntil: '2027-01-10' });
  });
});
