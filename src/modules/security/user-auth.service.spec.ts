import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { UnauthorizedException } from '@nestjs/common';
import { UserAuthService } from './user-auth.service';

const ISSUER = 'https://accounts.example.test';

let SignJWT: typeof import('jose').SignJWT;
let exportJWK: typeof import('jose').exportJWK;
let generateKeyPair: typeof import('jose').generateKeyPair;

describe('UserAuthService', () => {
  let server: Server;
  let service: UserAuthService;
  let privateKey: CryptoKey;
  let otherKey: CryptoKey;

  const sign = (
    key: CryptoKey,
    opts: { sub?: string; iss?: string; exp?: string } = {},
  ) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setSubject(opts.sub ?? 'user_a')
      .setIssuer(opts.iss ?? ISSUER)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '5m')
      .sign(key);

  beforeAll(async () => {
    ({ SignJWT, exportJWK, generateKeyPair } = await import('jose'));
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    otherKey = (await generateKeyPair('RS256')).privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };

    server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const values: Record<string, string> = {
      'auth.issuer': ISSUER,
      'auth.jwksUrl': `http://127.0.0.1:${port}/jwks`,
      'auth.audience': '',
    };
    service = new UserAuthService({
      get: (key: string) => values[key],
    } as never);
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('returns the subject of a valid token', async () => {
    await expect(service.verifyToken(await sign(privateKey))).resolves.toEqual({
      userId: 'user_a',
    });
  });

  it('accepts a Bearer header', async () => {
    const token = await sign(privateKey, { sub: 'user_b' });
    await expect(
      service.verifyAuthorizationHeader(`Bearer ${token}`),
    ).resolves.toEqual({ userId: 'user_b' });
  });

  it('rejects a missing token', async () => {
    await expect(service.verifyToken(undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      service.verifyAuthorizationHeader(undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an expired token', async () => {
    const token = await sign(privateKey, { exp: '-1m' });
    await expect(service.verifyToken(token)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token signed with a different key', async () => {
    await expect(
      service.verifyToken(await sign(otherKey)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token from a different issuer', async () => {
    const token = await sign(privateKey, { iss: 'https://evil.example.test' });
    await expect(service.verifyToken(token)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a tampered token', async () => {
    const token = await sign(privateKey, { sub: 'user_a' });
    const [h, , s] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: 'user_victim', iss: ISSUER, exp: 9999999999 }),
    ).toString('base64url');
    await expect(
      service.verifyToken(`${h}.${forgedPayload}.${s}`),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
