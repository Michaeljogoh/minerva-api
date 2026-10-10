import { parseShopifyHandle } from './shopify-domain';

describe('parseShopifyHandle', () => {
  it.each([
    ['acme', 'acme'],
    ['  Acme  ', 'acme'],
    ['acme.myshopify.com', 'acme'],
    ['https://acme.myshopify.com', 'acme'],
    ['https://acme.myshopify.com/admin/orders', 'acme'],
    ['https://admin.shopify.com/store/acme', 'acme'],
    ['admin.shopify.com/store/acme/orders', 'acme'],
    ['my-store-2', 'my-store-2'],
  ])('accepts %s', (input, expected) => {
    expect(parseShopifyHandle(input)).toBe(expected);
  });

  it.each([
    '',
    'acme.com',
    'shop.acme.com',
    'evil.com/acme.myshopify.com',
    'acme.myshopify.com.evil.com',
    'acme/../../x',
    'ac me',
    '-acme',
    'acme-',
    'javascript:alert(1)',
    'https://admin.shopify.com/settings',
    'a'.repeat(80),
    'acme?x=1',
    'acme#frag',
    'user@acme',
  ])('rejects %s', (input) => {
    expect(parseShopifyHandle(input)).toBeNull();
  });
});
