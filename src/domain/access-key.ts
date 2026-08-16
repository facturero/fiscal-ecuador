export function checkDigitMod11(digits48: string): string {
  const weights = [2, 3, 4, 5, 6, 7];
  let sum = 0;
  let weightIndex = 0;
  for (let i = digits48.length - 1; i >= 0; i--) {
    sum += parseInt(digits48[i], 10) * weights[weightIndex % weights.length];
    weightIndex++;
  }
  const mod = sum % 11;
  const result = 11 - mod;
  if (result === 11) return '0';
  if (result === 10) return '1';
  return String(result);
}

export function buildAccessKey(input: {
  issueDate: Date;
  documentTypeCode: string;
  issuerRuc: string;
  environment: 'pruebas' | 'produccion';
  establishmentCode: string;
  emissionPointCode: string;
  sequentialNumber: string;
}): string {
  const dd = String(input.issueDate.getDate()).padStart(2, '0');
  const mm = String(input.issueDate.getMonth() + 1).padStart(2, '0');
  const yyyy = String(input.issueDate.getFullYear());
  const fecha = `${dd}${mm}${yyyy}`;
  const ambiente = input.environment === 'produccion' ? '2' : '1';
  const serie = `${input.establishmentCode}${input.emissionPointCode}`;
  const codigoNumerico = String(Math.floor(Math.random() * 100000000)).padStart(8, '0');
  const tipoEmision = '1';

  const base48 = `${fecha}${input.documentTypeCode}${input.issuerRuc}${ambiente}${serie}${input.sequentialNumber}${codigoNumerico}${tipoEmision}`;
  if (base48.length !== 48) throw new Error(`Clave de acceso mal formada: ${base48.length} dígitos, se esperaban 48`);

  return base48 + checkDigitMod11(base48);
}
