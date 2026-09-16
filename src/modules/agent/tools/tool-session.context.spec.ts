import { ToolSessionContext } from './tool-session.context';

describe('ToolSessionContext', () => {
  const ctx = new ToolSessionContext();

  it('isolates clientId across concurrent bindGenerator runs', async () => {
    async function* gen(label: string): AsyncGenerator<string> {
      await Promise.resolve();
      yield `${label}:${ctx.requireClientId()}`;
    }

    const [a, b] = await Promise.all([
      (async () => {
        const out: string[] = [];
        for await (const v of ctx.bindGenerator(
          { clientId: 'client-a' },
          () => gen('a'),
        )) {
          out.push(v);
        }
        return out;
      })(),
      (async () => {
        await new Promise((r) => setTimeout(r, 5));
        const out: string[] = [];
        for await (const v of ctx.bindGenerator(
          { clientId: 'client-b' },
          () => gen('b'),
        )) {
          out.push(v);
        }
        return out;
      })(),
    ]);

    expect(a).toEqual(['a:client-a']);
    expect(b).toEqual(['b:client-b']);
  });

  it('tracks human approval within a run', async () => {
    async function* gen(): AsyncGenerator<boolean> {
      yield ctx.hasHumanApproval();
      ctx.grantHumanApproval();
      yield ctx.hasHumanApproval();
      yield ctx.consumeHumanApproval();
      yield ctx.hasHumanApproval();
    }

    const out: boolean[] = [];
    for await (const v of ctx.bindGenerator({ clientId: 'c1' }, gen)) {
      out.push(v);
    }
    expect(out).toEqual([false, true, true, false]);
  });
});
