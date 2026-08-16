import forge from 'node-forge';

const oids: Record<string, string> = (forge as any).oids;

export interface SignResult {
  signedXml: string;
  certificateSerial: string;
}

export function signXmlWithP12(unsignedXml: string, p12Buffer: Buffer, password: string): SignResult {
  if (p12Buffer.length === 0) throw new Error('El buffer del .p12 está vacío');

  const p12Bytes = p12Buffer.toString('binary');
  const p12Asn1 = forge.asn1.fromDer(p12Bytes);
  const p12 = (forge as any).pkcs12.pkcs12FromAsn1(p12Asn1, false, password);

  const keyBags = p12.getBags({ bagType: oids.pkcs8ShroudedKeyBag });
  const certBags = p12.getBags({ bagType: oids.certBag });

  const keyBag = keyBags[oids.pkcs8ShroudedKeyBag]?.[0];
  const certBag = certBags[oids.certBag]?.[0];
  if (!keyBag?.key) throw new Error('No se encontró la clave privada en el .p12');
  if (!certBag?.cert) throw new Error('No se encontró el certificado en el .p12');

  const privateKey = keyBag.key;
  const certificate = certBag.cert;
  const certSerial = certificate.serialNumber;

  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes();

  const certDigestMd = forge.md.sha256.create();
  certDigestMd.update(certDer);
  const certDigestValue = forge.util.encode64(certDigestMd.digest().getBytes());

  const certBase64 = forge.util.encode64(certDer);

  const now = new Date();
  const signingTime = formatXmlTime(now);

  const issuerName = getDnName(certificate.issuer);
  const serialNumber = certificate.serialNumber;

  const signedPropertiesXml = buildSignedProperties(signingTime, certDigestValue, issuerName, serialNumber);

  const docMd = forge.md.sha256.create();
  docMd.update(unsignedXml, 'utf8');
  const docDigest = forge.util.encode64(docMd.digest().getBytes());

  const spMd = forge.md.sha256.create();
  spMd.update(signedPropertiesXml, 'utf8');
  const spDigest = forge.util.encode64(spMd.digest().getBytes());

  const signedInfoXml = buildSignedInfo(docDigest, spDigest);

  const siMd = forge.md.sha256.create();
  siMd.update(signedInfoXml, 'utf8');

  const signer = (forge as any).pki.rsa;
  const signatureBytes = signer.sign(siMd, privateKey);
  const signatureValue = forge.util.encode64(signatureBytes);

  const signatureId = `Signature-${certSerial}`;
  const signatureXml = buildSignatureXml(signedInfoXml, signatureValue, signedPropertiesXml, certBase64, signatureId, certSerial);

  const insertPoint = unsignedXml.indexOf('</factura>');
  if (insertPoint === -1) throw new Error('No se encontró cierre de <factura> en el XML');

  const signedXml = unsignedXml.slice(0, insertPoint) + signatureXml + '\n' + unsignedXml.slice(insertPoint);

  return { signedXml, certificateSerial: certSerial };
}

export function validateP12Password(p12Buffer: Buffer, password: string): void {
  const p12Bytes = p12Buffer.toString('binary');
  const p12Asn1 = forge.asn1.fromDer(p12Bytes);
  (forge as any).pkcs12.pkcs12FromAsn1(p12Asn1, false, password);
}

export function extractP12Validity(p12Buffer: Buffer, password: string): { validFrom: string; validUntil: string } {
  const p12Bytes = p12Buffer.toString('binary');
  const p12Asn1 = forge.asn1.fromDer(p12Bytes);
  const p12 = (forge as any).pkcs12.pkcs12FromAsn1(p12Asn1, false, password);

  const certBags = p12.getBags({ bagType: oids.certBag });
  const certBag = certBags[oids.certBag]?.[0];
  if (!certBag?.cert) throw new Error('No se encontró el certificado en el .p12');

  const cert = certBag.cert;

  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  return {
    validFrom: fmt(cert.validity.notBefore),
    validUntil: fmt(cert.validity.notAfter),
  };
}

function getDnName(distinguishedName: forge.pki.Certificate['issuer']): string {
  const parts: string[] = [];
  for (const attr of distinguishedName.attributes) {
    parts.push(`${attr.shortName ?? attr.name}=${attr.value}`);
  }
  return parts.join(', ');
}

function formatXmlTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = date.getUTCFullYear();
  const mm = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mi = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`;
}

function buildSignedInfo(docDigest: string, spDigest: string): string {
  return `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:ec="http://www.sri.gob.ec/factura-electronica">
      <ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:CanonicalizationMethod>
      <ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"></ds:SignatureMethod>
      <ds:Reference URI="#comprobante">
        <ds:Transforms>
          <ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></ds:Transform>
          <ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:Transform>
        </ds:Transforms>
        <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>
        <ds:DigestValue>${docDigest}</ds:DigestValue>
      </ds:Reference>
      <ds:Reference URI="#xadesSignedProperties" Type="http://uri.etsi.org/01903#SignedProperties">
        <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>
        <ds:DigestValue>${spDigest}</ds:DigestValue>
      </ds:Reference>
    </ds:SignedInfo>`;
}

function buildSignedProperties(signingTime: string, certDigestValue: string, issuerName: string, serialNumber: string): string {
  return `<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="xadesSignedProperties">
      <xades:SignedSignatureProperties>
        <xades:SigningTime>${signingTime}</xades:SigningTime>
        <xades:SigningCertificate>
          <xades:Cert>
            <xades:CertDigest>
              <ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>
              <ds:DigestValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${certDigestValue}</ds:DigestValue>
            </xades:CertDigest>
            <xades:IssuerSerial>
              <ds:X509IssuerName xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${escapeXml(issuerName)}</ds:X509IssuerName>
              <ds:X509SerialNumber xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${serialNumber}</ds:X509SerialNumber>
            </xades:IssuerSerial>
          </xades:Cert>
        </xades:SigningCertificate>
      </xades:SignedSignatureProperties>
    </xades:SignedProperties>`;
}

function buildSignatureXml(signedInfo: string, signatureValue: string, signedPropertiesXml: string, certBase64: string, signatureId: string, _certSerial: string): string {
  return `<ds:Signature Id="${signatureId}" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
${signedInfo}
      <ds:SignatureValue>${signatureValue}</ds:SignatureValue>
      <ds:KeyInfo>
        <ds:X509Data>
          <ds:X509Certificate>${certBase64}</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
      <ds:Object>
        <xades:QualifyingProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="#${signatureId}">
${signedPropertiesXml}
        </xades:QualifyingProperties>
      </ds:Object>
    </ds:Signature>`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
