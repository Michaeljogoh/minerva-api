import { ComposioService } from './composio.service';

type Row = Record<string, unknown>;

function makeService(opts: { shopifyAuthConfig?: string } = {}) {
  const values: Record<string, unknown> = {
    'composio.apiKey': 'test-key',
    'composio.userIdPrefix': 'minerva:',
    'composio.shopifyAuthConfigId': opts.shopifyAuthConfig ?? 'ac_shopify',
    'composio.callbackUrl': 'http://localhost:3000/app/connected',
  };
  const rows: Row[] = [];
  const repo = {
    findOne: jest.fn(async ({ where }: { where: Row }) =>
      rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
    ),
    find: jest.fn(async () => rows),
    create: jest.fn((r: Row) => ({ ...r })),
    save: jest.fn(async (r: Row) => {
      if (!rows.includes(r)) rows.push(r);
      return r;
    }),
    delete: jest.fn(async () => undefined),
  };
  const service = new ComposioService(
    { get: (k: string) => values[k] } as never,
    repo as never,
  );
  return { service, rows };
}

function mockFetch(handler: (url: string, init: RequestInit) => unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  global.fetch = jest.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const body = handler(String(url), init);
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as never;
  return calls;
}

describe('ComposioService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('namespaces the Composio user id per account', () => {
    const { service } = makeService();
    expect(service.composioUserId('user_a')).toBe('minerva:user_a');
    expect(service.composioUserId('user_b')).not.toBe(
      service.composioUserId('user_a'),
    );
  });

  it("looks up only the calling user's connection", async () => {
    const { service } = makeService();
    const calls = mockFetch(() => ({
      items: [{ id: 'ca_1', status: 'ACTIVE', toolkit: { slug: 'shopify' } }],
    }));
    await service.findActiveAccountId('user_a', 'shopify');
    await service.findActiveAccountId('user_b', 'shopify');
    expect(calls[0].url).toContain('user_ids=minerva%3Auser_a');
    expect(calls[1].url).toContain('user_ids=minerva%3Auser_b');
  });

  it('does not count a pending link as connected', async () => {
    const { service } = makeService();
    mockFetch(() => ({
      items: [{ id: 'ca_1', status: 'INITIATED', toolkit: { slug: 'shopify' } }],
    }));
    await expect(service.isConnected('user_a', 'shopify')).resolves.toBe(false);
  });

  it('creates a Shopify link with the auth config and store subdomain', async () => {
    const { service } = makeService();
    const calls = mockFetch(() => ({
      redirect_url: 'https://connect.example/abc',
      connected_account_id: 'ca_9',
    }));
    const result = await service.requestAccess('user_a', 'shopify', {
      subdomain: 'acme',
    });
    expect(result).toMatchObject({
      mode: 'composio',
      connectUrl: 'https://connect.example/abc',
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({
      auth_config_id: 'ac_shopify',
      user_id: 'minerva:user_a',
      connection_data: { subdomain: 'acme' },
    });
  });

  it('never falls back to browser login for Shopify', async () => {
    const { service } = makeService();
    mockFetch(() => {
      throw new Error('boom');
    });
    const result = await service.requestAccess('user_a', 'shopify', {
      subdomain: 'acme',
    });
    expect(result.mode).toBe('unavailable');

    const noConfig = makeService({ shopifyAuthConfig: '' }).service;
    expect((await noConfig.requestAccess('user_a', 'shopify')).mode).toBe(
      'unavailable',
    );
  });

  it('refuses write actions and unknown slugs', async () => {
    const { service } = makeService();
    const calls = mockFetch(() => ({ items: [] }));
    for (const action of [
      'SHOPIFY_CREATE_PRODUCT',
      'SHOPIFY_DELETE_ORDER',
      'SHOPIFY_GET_ORDER_LIST/../x',
      'STRIPE_LIST_PAYOUTS',
    ]) {
      const result = await service.executeAction({
        userId: 'user_a',
        toolkit: action.startsWith('STRIPE') ? 'stripe' : 'shopify',
        action,
      });
      expect(result.ok).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it('runs a read action on the calling user\'s own account', async () => {
    const { service } = makeService();
    const calls = mockFetch((url) =>
      url.includes('/connected_accounts')
        ? { items: [{ id: 'ca_mine', status: 'ACTIVE', toolkit: { slug: 'shopify' } }] }
        : { data: { orders: [] }, successful: true },
    );
    const result = await service.executeAction({
      userId: 'user_a',
      toolkit: 'shopify',
      action: 'SHOPIFY_GET_ORDER_LIST',
      argumentsJson: '{"limit":5}',
    });
    expect(result.ok).toBe(true);
    const exec = calls.find((c) => c.url.includes('/tools/execute/'))!;
    expect(JSON.parse(String(exec.init.body))).toMatchObject({
      connected_account_id: 'ca_mine',
      user_id: 'minerva:user_a',
      arguments: { limit: 5 },
    });
  });
});
