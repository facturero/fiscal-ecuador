/**
 * Fechas de los comprobantes, siempre en hora de Ecuador.
 *
 * El pod corre en UTC. Con `getDate()` una factura emitida a las 20:00 en
 * Guayaquil (01:00 UTC del día siguiente) salía con fecha de mañana, tanto en
 * `fechaEmision` como dentro de la clave de acceso. Ecuador continental está en
 * UTC-5 todo el año, pero se usa la zona IANA y no un desfase fijo para no
 * depender de esa suposición.
 */
const TIME_ZONE = 'America/Guayaquil';

function parts(date: Date): { dd: string; mm: string; yyyy: string } {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => formatted.find((p) => p.type === type)?.value ?? '';
  return { dd: get('day'), mm: get('month'), yyyy: get('year') };
}

/** `dd/mm/aaaa`, el formato de `fechaEmision`. */
export function sriDate(date: Date): string {
  const { dd, mm, yyyy } = parts(date);
  return `${dd}/${mm}/${yyyy}`;
}

/** `ddmmaaaa`, el formato de la fecha dentro de la clave de acceso. */
export function accessKeyDate(date: Date): string {
  const { dd, mm, yyyy } = parts(date);
  return `${dd}${mm}${yyyy}`;
}

/** `aaaa-mm-dd` del día de hoy en Ecuador, para comparar vigencias. */
export function ecuadorToday(now = new Date()): string {
  const { dd, mm, yyyy } = parts(now);
  return `${yyyy}-${mm}-${dd}`;
}
