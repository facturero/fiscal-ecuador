export interface OrganizationInfo {
  id: string;
  legalName: string | null;
  tradeName: string | null;
  taxId: string | null;
  countryCode: string | null;
  status: string;
  completed: boolean;
  settings: Record<string, unknown> | null;
}

export class HttpOrganizationCatalog {
  constructor(private readonly orgServiceUrl: string) {}

  async getOrganization(organizationId: string): Promise<OrganizationInfo | null> {
    const response = await fetch(`${this.orgServiceUrl}/organizations/me`, {
      headers: { 'X-Organization-Id': organizationId },
    });
    if (!response.ok) {
      console.warn(`[HttpOrganizationCatalog] Error fetching org (${response.status})`);
      return null;
    }
    return response.json() as Promise<OrganizationInfo>;
  }
}
