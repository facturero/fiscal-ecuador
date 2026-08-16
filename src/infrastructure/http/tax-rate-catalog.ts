export interface TaxRateInfo {
  id: string;
  countryCode: string;
  code: string;
  name: string;
  percentage: number;
  kind: string;
  isDefault: boolean;
}

export class HttpTaxRateCatalog {
  constructor(private readonly taxServiceUrl: string) {}

  async findByCountry(countryCode: string): Promise<TaxRateInfo[]> {
    const response = await fetch(`${this.taxServiceUrl}/countries/${countryCode}/tax-rates`);
    if (!response.ok) {
      console.warn(`[HttpTaxRateCatalog] Error fetching tax rates (${response.status})`);
      return [];
    }
    return response.json() as Promise<TaxRateInfo[]>;
  }
}
