import request from 'supertest';

import { createApp } from './app';

describe('createApp', () => {
  const app = createApp();

  it('responds to the health check', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await request(app).get('/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND' });
  });

  it('does not advertise the framework', async () => {
    const res = await request(app).get('/health');

    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
