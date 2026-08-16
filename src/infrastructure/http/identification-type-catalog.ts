export interface IdentificationTypeInfo {
  id: string;
  countryCode: string;
  code: string;
  name: string;
  regex: string | null;
}

export class HttpIdentificationTypeCatalog {
  constructor(private readonly taxServiceUrl: string) {}

  async findByCountry(countryCode: string): Promise<IdentificationTypeInfo[]> {
    const response = await fetch(`${this.taxServiceUrl}/countries/${countryCode}/identification-types`);
    if (!response.ok) {
      console.warn(`[HttpIdentificationTypeCatalog] Error fetching identification types (${response.status})`);
      return [];
    }
    return response.json() as Promise<IdentificationTypeInfo[]>;
  }
}
