import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { DOCUMENT_NAMES } from './ride-pdf.js';
import type { DeliveryGuidePayload, WithholdingPayload } from './direct-documents.js';

/**
 * RIDE de los comprobantes que fiscal emite directamente: retención (07) y guía de remisión (06). Mismo criterio que el de
 * facturas (`ride-pdf.ts`): se genera al vuelo desde el payload guardado y los datos de autorización, solo existe para
 * comprobantes AUTORIZADOS y en pruebas lleva la leyenda de que no tiene validez tributaria.
 */

export interface DirectRideAuthorization {
  number: string;
  accessKey: string;
  authorizationNumber: string;
  authorizationDate: string | null;
  environment: 'pruebas' | 'produccion';
  qrContent: string;
}

const TAX_NAMES = { income: 'RENTA', vat: 'IVA', isd: 'ISD' } as const;

const money = (cents: number): string => (cents / 100).toFixed(2);

function formatDate(value: string | null): string {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('es-EC', { dateStyle: 'long', timeStyle: 'short' });
}

/** `AAAA-MM-DD` → `dd/mm/aaaa`, sin pasar por `Date`. */
const day = (iso: string): string => iso.split('-').reverse().join('/');

type Doc = InstanceType<typeof PDFDocument>;

function header(doc: Doc, documentType: '06' | '07', auth: DirectRideAuthorization, qrPng: Buffer, issuer: WithholdingPayload['issuerSnapshot']): void {
  if (auth.environment === 'pruebas') {
    doc.fontSize(14).font('Helvetica-Bold').fillColor('white');
    doc.rect(0, 0, doc.page.width, 24).fill('#c62828');
    doc.text('AMBIENTE DE PRUEBAS', doc.page.width / 2, 8, { align: 'center', width: 0 });
    doc.fillColor('black').font('Helvetica');
  }
  doc.image(qrPng, doc.page.width - 48 - 70, 40, { width: 70 });
  doc.fontSize(18).font('Helvetica-Bold').text(DOCUMENT_NAMES[documentType] ?? 'COMPROBANTE', 48, 44, { align: 'center' });
  doc.moveDown(0.2);
  doc.fontSize(9).font('Helvetica').text('REPRESENTACIÓN IMPRESA DEL DOCUMENTO ELECTRÓNICO', { align: 'center' });
  doc.moveDown(0.6);
  doc.text(`Número: ${auth.number}`, { align: 'center' });
  doc.moveDown(1);

  doc.fontSize(10).font('Helvetica-Bold').text('AUTORIZACIÓN');
  doc.font('Helvetica').fontSize(9);
  doc.moveDown(0.2);
  doc.font('Helvetica-Bold').text('Número de autorización: ', { continued: true }).font('Helvetica').text(auth.authorizationNumber || auth.accessKey);
  doc.text(`Fecha de autorización: ${formatDate(auth.authorizationDate)}`);
  doc.fontSize(8).font('Helvetica-Bold').text('Clave de acceso:');
  doc.font('Helvetica').text(auth.accessKey);
  doc.moveDown(0.8);

  doc.fontSize(10).font('Helvetica-Bold').text('EMISOR');
  doc.font('Helvetica').fontSize(9);
  doc.moveDown(0.2);
  doc.text(issuer.legalName);
  doc.text(`RUC: ${issuer.taxId}  —  Establecimiento / Punto: ${issuer.establishmentCode} · ${issuer.emissionPointCode}`);
  if (issuer.address) doc.text(issuer.address);
  doc.moveDown(0.8);
}

function footer(doc: Doc, auth: DirectRideAuthorization): void {
  doc.moveDown(2);
  if (auth.environment === 'pruebas') {
    doc.fontSize(8).font('Helvetica').fillColor('#c62828');
    doc.text('DOCUMENTO DE PRUEBA — SIN VALIDEZ TRIBUTARIA', 48, doc.y, { align: 'center', width: 498 });
    doc.fillColor('black');
  }
  doc.fontSize(8).font('Helvetica').fillColor('grey');
  doc.text('Documento electrónico generado automáticamente. Verifique su validez en el sitio del SRI escaneando el código QR o ingresando la clave de acceso.', 48, doc.y + 2, { align: 'center', width: 498 });
  doc.fillColor('black');
}

function render(qrContent: string, draw: (doc: Doc, qrPng: Buffer) => void): Promise<Buffer> {
  return QRCode.toBuffer(qrContent, { type: 'png', width: 240, margin: 1 }).then(
    (qrPng) =>
      new Promise<Buffer>((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 48 });
        const chunks: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        draw(doc, qrPng);
        doc.end();
      }),
  );
}

export function renderWithholdingRide(payload: WithholdingPayload, auth: DirectRideAuthorization): Promise<Buffer> {
  return render(auth.qrContent, (doc, qrPng) => {
    header(doc, '07', auth, qrPng, payload.issuerSnapshot);

    doc.fontSize(10).font('Helvetica-Bold').text('SUJETO RETENIDO');
    doc.font('Helvetica').fontSize(9);
    doc.moveDown(0.2);
    doc.text(payload.subject.businessName);
    doc.text(`Identificación: ${payload.subject.identification}`);
    doc.text(`Periodo fiscal: ${payload.fiscalPeriod}`);
    doc.moveDown(0.8);

    doc.fontSize(10).font('Helvetica-Bold').text('COMPROBANTE DE SUSTENTO');
    doc.font('Helvetica').fontSize(9);
    doc.moveDown(0.2);
    doc.text(`Tipo ${payload.support.documentCode} · Número ${payload.support.number} · Fecha ${day(payload.support.issueDate)}`);
    doc.text(`Base sin impuestos: ${money(payload.support.totalWithoutTaxesCents)}   Total: ${money(payload.support.totalCents)}`);
    doc.moveDown(0.8);

    const cols = { tax: 48, code: 130, base: 220, rate: 330, value: 430 };
    const top = doc.y;
    doc.fontSize(9).font('Helvetica-Bold');
    doc.text('Impuesto', cols.tax, top, { width: 80 });
    doc.text('Código', cols.code, top, { width: 80 });
    doc.text('Base imponible', cols.base, top, { width: 100, align: 'right' });
    doc.text('% retenido', cols.rate, top, { width: 80, align: 'right' });
    doc.text('Valor retenido', cols.value, top, { width: 110, align: 'right' });
    doc.moveTo(48, top + 14).lineTo(540, top + 14).stroke();
    doc.moveDown(0.8);

    doc.font('Helvetica');
    for (const line of payload.withholdings) {
      const y = doc.y;
      doc.text(TAX_NAMES[line.tax], cols.tax, y, { width: 80 });
      doc.text(line.retentionCode, cols.code, y, { width: 80 });
      doc.text(money(line.baseCents), cols.base, y, { width: 100, align: 'right' });
      doc.text(line.ratePercent.toFixed(2), cols.rate, y, { width: 80, align: 'right' });
      doc.text(money(line.amountCents), cols.value, y, { width: 110, align: 'right' });
      doc.moveDown(0.4);
    }
    doc.moveTo(48, doc.y).lineTo(540, doc.y).stroke();
    doc.moveDown(0.6);
    doc.fontSize(12).font('Helvetica-Bold').text(`TOTAL RETENIDO: USD ${money(payload.totalWithheldCents)}`, 330, doc.y, { width: 210, align: 'right' });

    footer(doc, auth);
  });
}

export function renderDeliveryGuideRide(payload: DeliveryGuidePayload, auth: DirectRideAuthorization): Promise<Buffer> {
  return render(auth.qrContent, (doc, qrPng) => {
    header(doc, '06', auth, qrPng, payload.issuerSnapshot);

    doc.fontSize(10).font('Helvetica-Bold').text('TRANSPORTE');
    doc.font('Helvetica').fontSize(9);
    doc.moveDown(0.2);
    doc.text(`Transportista: ${payload.carrier.businessName} (${payload.carrier.identification})`);
    doc.text(`Placa: ${payload.carrier.plate}${payload.carrier.rise ? `   RISE: ${payload.carrier.rise}` : ''}`);
    doc.text(`Punto de partida: ${payload.originAddress}`);
    doc.text(`Traslado desde ${day(payload.transportStart)} hasta ${day(payload.transportEnd)}`);
    doc.moveDown(0.8);

    payload.recipients.forEach((recipient, i) => {
      doc.fontSize(10).font('Helvetica-Bold').text(`DESTINATARIO ${i + 1}`);
      doc.font('Helvetica').fontSize(9);
      doc.moveDown(0.2);
      doc.text(`${recipient.businessName} (${recipient.identification})`);
      doc.text(`Destino: ${recipient.address}`);
      doc.text(`Motivo del traslado: ${recipient.reason}`);
      if (recipient.route) doc.text(`Ruta: ${recipient.route}`);
      if (recipient.support) {
        doc.text(`Comprobante de venta: tipo ${recipient.support.documentCode} ${recipient.support.number} del ${day(recipient.support.issueDate)}`);
      }
      doc.moveDown(0.4);
      doc.font('Helvetica-Bold').text('Cantidad', 48, doc.y, { width: 70, continued: false });
      doc.moveUp();
      doc.text('Descripción', 130, doc.y, { width: 410 });
      doc.font('Helvetica');
      for (const item of recipient.items) {
        const y = doc.y;
        doc.text(String(item.quantity), 48, y, { width: 70 });
        doc.text(`${item.internalCode ? `[${item.internalCode}] ` : ''}${item.description}`, 130, y, { width: 410 });
      }
      doc.moveDown(0.8);
    });

    footer(doc, auth);
  });
}
