import { Lifecycle } from './lifecycle';

describe('Lifecycle', () => {
  it('closes resources in reverse registration order', async () => {
    const order: string[] = [];
    const lifecycle = new Lifecycle();
    lifecycle.register(() => {
      order.push('redis');
      return Promise.resolve();
    });
    lifecycle.register(() => {
      order.push('kafka');
      return Promise.resolve();
    });

    await lifecycle.close();

    expect(order).toEqual(['kafka', 'redis']);
  });

  it('runs closers only once across repeated close calls', async () => {
    const closer = jest.fn(() => Promise.resolve());
    const lifecycle = new Lifecycle();
    lifecycle.register(closer);

    await Promise.all([lifecycle.close(), lifecycle.close()]);

    expect(closer).toHaveBeenCalledTimes(1);
  });

  it('attempts every closer and aggregates failures', async () => {
    const after = jest.fn(() => Promise.resolve());
    const lifecycle = new Lifecycle();
    lifecycle.register(after);
    lifecycle.register(() => Promise.reject(new Error('boom')));

    await expect(lifecycle.close()).rejects.toBeInstanceOf(AggregateError);
    expect(after).toHaveBeenCalledTimes(1);
  });
});
