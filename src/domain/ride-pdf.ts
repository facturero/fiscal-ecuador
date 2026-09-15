import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

/**
 * RIDE (Representación Impresa del Documento Electrónico) tributario. A
 * diferencia del PDF "comercial" de billing-service, este documento tiene
 * validez tributaria: lleva el número de autorización y la clave de acceso del
 * comprobante autorizado, el código QR del SRI y los datos fiscales completos.
 *
 * Se genera al vuelo desde `original_payload` + datos de autorización, no se
 * almacena: fiscal guarda todo lo que lo arma y así no hay que sincronizar un
 * PDF con su registro (el diseño original preveía `ride_file_id`; generar bajo
 * demanda evita la migración y la dependencia de document-service en el
 * consumer).
 */

export const DOCUMENT_NAMES: Record<string, string> = {
  '01': 'FACTURA',
  '04': 'NOTA DE CRÉDITO',
};

export interface RidePdfLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
  subtotalCents: number;
  taxes: Array<{ kind: string; rateSnapshot: string; amountCents: number }>;
}

export interface RidePdfData {
  documentType: string;
  number: string;
  accessKey: string;
  authorizationNumber: string;
  authorizationDate: string | null;
  environment: 'pruebas' | 'produccion';
  currency: string;
  subtotalCents: number;
  taxTotalCents: number;
  totalCents: number;
  qrContent: string;
  issuer: {
    legalName: string;
    tradeName?: string | null;
    taxId: string;
    address?: string | null;
    establishmentCode?: string;
    emissionPointCode?: string;
  } | null;
  customer: {
    businessName: string;
    identification: string;
    email?: string | null;
    phone?: string | null;
  } | null;
  lines: RidePdfLine[];
}

function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

function formatDate(value: string | null): string {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleString('es-EC', { dateStyle: 'long', timeStyle: 'short' });
}

function taxGroups(lines: RidePdfLine[]): Array<{ label: string; amountCents: number }> {
  const grouped: Record<string, number> = {};
  for (const line of lines) {
    for (const tax of line.taxes) {
      const key = `${tax.kind} ${tax.rateSnapshot}`;
      grouped[key] = (grouped[key] || 0) + tax.amountCents;
    }
  }
  return Object.entries(grouped).map(([label, amountCents]) => ({ label, amountCents }));
}

export async function renderRidePdf(data: RidePdfData): Promise<Buffer> {
  const qrPng = await QRCode.toBuffer(data.qrContent, { type: 'png', width: 240, margin: 1 });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const documentName = DOCUMENT_NAMES[data.documentType] ?? 'COMPROBANTE';

    // Aviso de ambiente de pruebas: un RIDE de pruebas NO es un comprobante válido.
    if (data.environment === 'pruebas') {
      doc.fontSize(14).font('Helvetica-Bold').fillColor('white');
      doc.rect(0, 0, doc.page.width, 24).fill('#c62828');
      doc.text('AMBIENTE DE PRUEBAS', doc.page.width / 2, 8, { align: 'center', width: 0 });
      doc.fillColor('black').font('Helvetica');
    }

    doc.image(qrPng, doc.page.width - 48 - 70, 40, { width: 70 });

    doc.fontSize(18).font('Helvetica-Bold').text(documentName, 48, 44, { align: 'center' });
    doc.moveDown(0.2);
    doc.fontSize(9).font('Helvetica').text('REPRESENTACIÓN IMPRESA DEL DOCUMENTO ELECTRÓNICO', { align: 'center' });
    doc.moveDown(0.6);
    doc.text(`Número: ${data.number}`, { align: 'center' });
    doc.moveDown(1);

    // Autorización
    doc.fontSize(10).font('Helvetica-Bold').text('AUTORIZACIÓN');
    doc.font('Helvetica').fontSize(9);
    doc.moveDown(0.2);
    doc.fontSize(9).font('Helvetica-Bold').text(`Número de autorización: `, { continued: true }).font('Helvetica').text(data.authorizationNumber || data.accessKey);
    doc.text(`Fecha de autorización: ${formatDate(data.authorizationDate)}`);
    doc.fontSize(8).font('Helvetica-Bold').text('Clave de acceso:', { continued: false });
    doc.font('Helvetica').text(data.accessKey);
    doc.moveDown(0.8);

    // Emisor
    if (data.issuer) {
      doc.fontSize(10).font('Helvetica-Bold').text('EMISOR');
      doc.font('Helvetica').fontSize(9);
      doc.moveDown(0.2);
      doc.text(data.issuer.legalName);
      const ext = [data.issuer.establishmentCode, data.issuer.emissionPointCode].filter(Boolean).join(' · ');
      doc.text(`RUC: ${data.issuer.taxId}${ext ? `  —  Establecimiento / Punto: ${ext}` : ''}`);
      if (data.issuer.address) doc.text(data.issuer.address);
      doc.moveDown(0.8);
    }

    // Adquirente
    if (data.customer) {
      doc.fontSize(10).font('Helvetica-Bold').text('ADQUIRIENTE');
      doc.font('Helvetica').fontSize(9);
      doc.moveDown(0.2);
      doc.text(data.customer.businessName);
      doc.text(`Identificación: ${data.customer.identification}`);
      if (data.customer.email) doc.text(`Email: ${data.customer.email}`);
      if (data.customer.phone) doc.text(`Teléfono: ${data.customer.phone}`);
      doc.moveDown(0.8);
    }

    // Tabla de líneas
    const colDesc = 48;
    const colQty = 290;
    const colPrice = 340;
    const colDisc = 410;
    const colSubtotal = 467;
    const tableTop = doc.y;

    doc.fontSize(9).font('Helvetica-Bold');
    doc.text('Detalle', colDesc, tableTop, { width: 200 });
    doc.text('Cant.', colQty, tableTop, { width: 40, align: 'right' });
    doc.text('P.Unit', colPrice, tableTop, { width: 60, align: 'right' });
    doc.text('Dscto', colDisc, tableTop, { width: 50, align: 'right' });
    doc.text('Subtotal', colSubtotal, tableTop, { width: 67, align: 'right' });

    doc.moveTo(48, tableTop + 14).lineTo(540, tableTop + 14).stroke();
    doc.moveDown(0.8);

    doc.font('Helvetica').fontSize(9);
    for (const line of data.lines) {
      const y = doc.y;
      doc.text(line.description || '-', colDesc, y, { width: 200 });
      doc.text(String(line.quantity), colQty, y, { width: 40, align: 'right' });
      doc.text(money(line.unitPriceCents), colPrice, y, { width: 60, align: 'right' });
      doc.text(money(line.discountCents), colDisc, y, { width: 50, align: 'right' });
      doc.text(money(line.subtotalCents), colSubtotal, y, { width: 67, align: 'right' });
      doc.moveDown(0.4);
      if (line.taxes.length) {
        doc.fontSize(8).fillColor('#616161');
        doc.text(line.taxes.map((t) => `${t.kind} ${t.rateSnapshot}: ${money(t.amountCents)}`).join(' · '), colDesc, doc.y, { width: 440 });
        doc.fillColor('black').fontSize(9);
        doc.moveDown(0.4);
      }
    }

    doc.moveTo(48, doc.y).lineTo(540, doc.y).stroke();
    doc.moveDown(0.8);

    // Totales
    const totalsX = 330;
    doc.fontSize(10).font('Helvetica');
    doc.text(`Subtotal: ${data.currency} ${money(data.subtotalCents)}`, totalsX, doc.y, { width: 210, align: 'right' });
    for (const group of taxGroups(data.lines)) {
      doc.text(`${group.label}: ${data.currency} ${money(group.amountCents)}`, totalsX, doc.y, { width: 210, align: 'right' });
    }
    doc.fontSize(12).font('Helvetica-Bold');
    doc.text(`TOTAL: ${data.currency} ${money(data.totalCents)}`, totalsX, doc.y + 4, { width: 210, align: 'right' });

    doc.moveDown(2);

    // Pie
    if (data.environment === 'pruebas') {
      doc.fontSize(8).font('Helvetica').fillColor('#c62828');
      doc.text('DOCUMENTO DE PRUEBA — SIN VALIDEZ TRIBUTARIA', 48, doc.y, { align: 'center', width: 498 });
      doc.fillColor('black');
    }
    doc.fontSize(8).font('Helvetica').fillColor('grey');
    doc.text('Documento electrónico generado automáticamente. Verifique su validez en el sitio del SRI escaneando el código QR o ingresando la clave de acceso.', 48, doc.y + 2, { align: 'center', width: 498 });
    doc.fillColor('black');

    doc.end();
  });
}