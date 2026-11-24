import {
  isAllowedConfiguredOrSubdomainOrigin,
  isExactConfiguredOrigin,
  isPublicSiteStudioCorsPath,
  isVerifiedSiteStudioCustomDomainOrigin,
} from './site-studio-cors.util';

describe('Site Studio CORS helpers', () => {
  it('limits dynamic custom-domain CORS to public Site Studio and checkout endpoints', () => {
    expect(isPublicSiteStudioCorsPath('/api/v1/public/site-studio/page')).toBe(
      true,
    );
    expect(
      isPublicSiteStudioCorsPath('/api/v1/stripe/create-checkout-session'),
    ).toBe(true);
    expect(isPublicSiteStudioCorsPath('/api/v1/stripe/checkout-status')).toBe(
      true,
    );
    expect(isPublicSiteStudioCorsPath('/api/v1/auth/me')).toBe(false);
    expect(isPublicSiteStudioCorsPath('/api/v1/stripe/products')).toBe(false);
  });

  it('covers the standalone public forms endpoints', () => {
    expect(isPublicSiteStudioCorsPath('/api/v1/public/forms')).toBe(true);
    expect(isPublicSiteStudioCorsPath('/api/v1/public/forms/my-form')).toBe(
      true,
    );
    expect(
      isPublicSiteStudioCorsPath('/api/v1/public/forms/my-form/submit'),
    ).toBe(true);
    expect(isPublicSiteStudioCorsPath('/api/v1/public/forms?slug=x')).toBe(
      true,
    );

    // Must not over-match a sibling path that merely shares the prefix string.
    expect(isPublicSiteStudioCorsPath('/api/v1/public/forms-admin')).toBe(
      false,
    );
  });

  it('allows configured frontend origins and their published subdomains', () => {
    const allowed = ['https://app.example.com', 'http://localhost:3000'];

    expect(
      isAllowedConfiguredOrSubdomainOrigin('https://app.example.com', allowed),
    ).toBe(true);
    expect(
      isAllowedConfiguredOrSubdomainOrigin(
        'https://tenant.app.example.com',
        allowed,
      ),
    ).toBe(true);
    expect(
      isAllowedConfiguredOrSubdomainOrigin(
        'http://preview.localhost:3000',
        allowed,
      ),
    ).toBe(true);
    expect(
      isAllowedConfiguredOrSubdomainOrigin('https://evil.example.com', allowed),
    ).toBe(false);
  });

  it('limits credentialed CORS to exact configured app origins', () => {
    const allowed = ['https://app.example.com', 'http://localhost:3000'];

    expect(isExactConfiguredOrigin('https://app.example.com', allowed)).toBe(
      true,
    );
    expect(
      isExactConfiguredOrigin('https://tenant.app.example.com', allowed),
    ).toBe(false);
    expect(
      isExactConfiguredOrigin('http://preview.localhost:3000', allowed),
    ).toBe(false);
  });

  it('allows verified custom Site Studio domains from the database', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: { id: 'domain-1' },
      error: null,
    });
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle,
    };
    const client = {
      from: jest.fn().mockReturnValue(query),
    };

    await expect(
      isVerifiedSiteStudioCustomDomainOrigin(
        'https://site.example',
        client as never,
      ),
    ).resolves.toBe(true);
    expect(client.from).toHaveBeenCalledWith('site_studio_domains');
    expect(query.eq).toHaveBeenCalledWith('domain', 'site.example');
    expect(query.eq).toHaveBeenCalledWith('verified', true);
  });

  it('can scope verified custom Site Studio domains to an organization', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: { id: 'domain-1' },
      error: null,
    });
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle,
    };
    const client = {
      from: jest.fn().mockReturnValue(query),
    };

    await expect(
      (
        isVerifiedSiteStudioCustomDomainOrigin as (
          ...args: unknown[]
        ) => Promise<boolean>
      )('https://site.example', client, new Map(), Date.now(), 'org-1'),
    ).resolves.toBe(true);

    expect(query.eq).toHaveBeenCalledWith('organization_id', 'org-1');
  });

  it('does not cache denied custom-domain lookups', async () => {
    const maybeSingle = jest
      .fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { id: 'domain-1' }, error: null });
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle,
    };
    const client = {
      from: jest.fn().mockReturnValue(query),
    };
    const cache = new Map();

    await expect(
      isVerifiedSiteStudioCustomDomainOrigin(
        'https://site.example',
        client as never,
        cache,
      ),
    ).resolves.toBe(false);
    await expect(
      isVerifiedSiteStudioCustomDomainOrigin(
        'https://site.example',
        client as never,
        cache,
      ),
    ).resolves.toBe(true);

    expect(maybeSingle).toHaveBeenCalledTimes(2);
  });

  it('denies plaintext custom Site Studio domains even when verified', async () => {
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { id: 'domain-1' },
        error: null,
      }),
    };
    const client = {
      from: jest.fn().mockReturnValue(query),
    };

    await expect(
      isVerifiedSiteStudioCustomDomainOrigin(
        'http://site.example',
        client as never,
      ),
    ).resolves.toBe(false);
    expect(client.from).not.toHaveBeenCalled();
  });

  it('denies unverified or invalid custom origins', async () => {
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    };
    const client = {
      from: jest.fn().mockReturnValue(query),
    };

    await expect(
      isVerifiedSiteStudioCustomDomainOrigin(
        'https://unverified.example',
        client as never,
      ),
    ).resolves.toBe(false);
    await expect(
      isVerifiedSiteStudioCustomDomainOrigin('not-a-url', client as never),
    ).resolves.toBe(false);
  });
});
