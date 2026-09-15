/**
 * Contenido del código QR que lleva el RIDE: la URL de consulta de comprobantes
 * del SRI con la clave de acceso ya cargada, para que cualquiera verifique el
 * documento con un escaneo. Si el SRI define otro formato en la Ficha Técnica
 * (ANEXO 2), se corrige aquí y/o en `RIDE_QR_BASE_URL` de la config.
 */
export function rideQrUrl(accessKey: string, baseUrl: string): string {
  return `${baseUrl}?clave_acceso=${accessKey}`;
}