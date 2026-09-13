import type { DocumentStore } from '../../application/ports.js';

/**
 * "fetch failed" a secas no dice nada: la causa real (ENOTFOUND, ECONNREFUSED,
 * timeout) viene en `cause`. Es lo que acaba en `last_error` y en la pantalla.
 */
export function describeFetchError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'tiempo de espera agotado';
  return e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
}

export class HttpDocumentStorage implements DocumentStore {
  constructor(
    private readonly documentServiceUrl: string,
    private readonly internalSecret: string,
    private readonly timeoutMs = 20_000,
  ) {}

  /**
   * `resourceType` lo decide quien sube: antes todo iba como `fiscal_invoice`,
   * también los certificados, que no son de ninguna factura.
   */
  async upload(params: {
    resourceType: 'fiscal_invoice' | 'fiscal_certificate';
    resourceId: string;
    category: string;
    originalName: string;
    mimeType: string;
    buffer: Buffer;
  }): Promise<string> {
    const formData = new FormData();
    formData.append('resourceType', params.resourceType);
    formData.append('resourceId', params.resourceId);
    formData.append('category', params.category);
    formData.append('originalName', params.originalName);
    formData.append('mimeType', params.mimeType);
    formData.append('uploadedBy', 'fiscal-ecuador');
    formData.append('file', new Blob([new Uint8Array(params.buffer)], { type: params.mimeType }), params.originalName);

    let response: Response;
    try {
      response = await fetch(`${this.documentServiceUrl}/files/internal`, {
        method: 'POST',
        headers: { 'X-Internal-Secret': this.internalSecret },
        body: formData,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new Error(`document-service no respondió al subir ${params.originalName}: ${describeFetchError(err)}`);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Error subiendo documento a document-service (${response.status}): ${text}`);
    }

    const body = await response.json() as { id?: string; fileId?: string };
    const id = body.id ?? body.fileId;
    if (!id) throw new Error('document-service no devolvió el id del archivo subido');
    return id;
  }

  /**
   * `/content` y no `/download`: `/download` redirige a una URL prefirmada del
   * endpoint PÚBLICO de MinIO, que desde dentro del clúster no se alcanza. Se
   * vio al emitir de punta a punta en el docker-compose: "fetch failed".
   */
  async download(fileId: string): Promise<Buffer> {
    const url = `${this.documentServiceUrl}/files/${fileId}/content`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { 'X-Internal-Secret': this.internalSecret },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new Error(`document-service no respondió al descargar ${fileId}: ${describeFetchError(err)}`);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Error descargando documento ${fileId} (${response.status}): ${text}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }
}
