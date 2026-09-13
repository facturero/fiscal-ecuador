#!/usr/bin/env node
/**
 * Genera un certificado .p12 AUTOFIRMADO para pruebas end-to-end y lo imprime
 * como JSON `{ "p12": "<base64>", "password": "..." }`.
 *
 * Sirve para ejercitar el flujo completo (subida, firma, envío al SRI de
 * pruebas). No lo emite una entidad acreditada por el SRI, así que la
 * autorización nunca va a salir AUTORIZADA con él: lo que valida es que el
 * comprobante está bien formado y llega a manos del SRI.
 *
 *   node scripts/make-test-p12.mjs [password]
 */
import forge from 'node-forge';

const password = process.argv[2] ?? 'prueba-e2e';
const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = Date.now().toString(16);
cert.validity.notBefore = new Date(Date.now() - 24 * 3600_000);
cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600_000);
const attrs = [
  { shortName: 'CN', value: 'PRUEBAS E2E FACTURERO' },
  { shortName: 'O', value: 'Pruebas' },
  { shortName: 'C', value: 'EC' },
];
cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.sign(keys.privateKey, forge.md.sha256.create());

const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' });
const p12 = Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary').toString('base64');
process.stdout.write(JSON.stringify({ p12, password }));
