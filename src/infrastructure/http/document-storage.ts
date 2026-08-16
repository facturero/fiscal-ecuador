export class HttpDocumentStorage {
  constructor(
    private readonly documentServiceUrl: string,
    private readonly internalSecret: string,
  ) {}

  async upload(params: { resourceId: string; category: string; originalName: string; mimeType: string; buffer: Buffer }): Promise<string> {
    const formData = new FormData();
    formData.append('resourceType', 'fiscal_invoice');
    formData.append('resourceId', params.resourceId);
    formData.append('category', params.category);
    formData.append('originalName', params.originalName);
    formData.append('mimeType', params.mimeType);
    formData.append('uploadedBy', 'fiscal-ecuador');
    formData.append('file', new Blob([new Uint8Array(params.buffer)], { type: params.mimeType }), params.originalName);

    const response = await fetch(`${this.documentServiceUrl}/files/internal`, {
      method: 'POST',
      headers: { 'X-Internal-Secret': this.internalSecret },
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Error subiendo documento a document-service (${response.status}): ${text}`);
    }

    const body = await response.json() as { id?: string; fileId?: string };
    return body.id ?? body.fileId ?? '';
  }

  async downloadFile(fileId: string): Promise<Buffer> {
    const response = await fetch(`${this.documentServiceUrl}/files/${fileId}/download`, {
      method: 'GET',
      headers: { 'X-Internal-Secret': this.internalSecret },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Error descargando documento ${fileId} (${response.status}): ${text}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
