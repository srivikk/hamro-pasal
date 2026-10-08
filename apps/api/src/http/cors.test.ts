import { auditContextSchema } from '@hamro-pasal/shared-types';
import express from 'express';
import request from 'supertest';

import { createApp } from '../app';
import { auditContextOf, requestId } from './request-context';

const ADMIN = 'https://admin.hamropasal.np';
const app = createApp(undefined, { corsAllowedOrigins: [ADMIN] });

const corsHeaders = (headers: Record<string, string>) =>
  Object.keys(headers).filter((name) => name.startsWith('access-control-'));

describe('strict CORS', () => {
  it('answers a request without an Origin (the mobile apps, curl) with no CORS headers', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(corsHeaders(res.headers)).toEqual([]);
  });

  it('lets a listed origin read the response, with credentials, and never with a wildcard', async () => {
    const res = await request(app).get('/health').set('Origin', ADMIN);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ADMIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-expose-headers']).toBe('X-Request-Id');
    expect(res.headers.vary).toContain('Origin');
  });

  it('answers a listed origin’s preflight without running the route', async () => {
    const res = await request(app)
      .options('/api/admin/vendors')
      .set('Origin', ADMIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization, content-type');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ADMIN);
    expect(res.headers['access-control-allow-methods']).toBe('GET, POST, PUT, PATCH, DELETE');
    expect(res.headers['access-control-allow-headers']).toBe(
      'Authorization, Content-Type, X-Request-Id',
    );
    expect(res.headers['access-control-max-age']).toBe('600');
    expect(res.text).toBe('');
  });

  it.each([
    'https://evil.example',
    'https://admin.hamropasal.np.evil.example',
    'http://admin.hamropasal.np',
    'https://admin.hamropasal.np:8443',
    'https://ADMIN.hamropasal.np',
    'null',
  ])('gives the unlisted origin %s no CORS header', async (origin) => {
    const res = await request(app).get('/health').set('Origin', origin);
    expect(res.status).toBe(200);
    expect(corsHeaders(res.headers)).toEqual([]);
    expect(res.headers.vary).toContain('Origin');
  });

  it('refuses an unlisted origin’s preflight', async () => {
    const res = await request(app)
      .options('/api/admin/vendors')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: { code: 'CORS_ORIGIN_NOT_ALLOWED', message: 'This origin may not call the API' },
    });
    expect(corsHeaders(res.headers)).toEqual([]);
  });

  it('allows no origin at all by default', async () => {
    const closed = createApp();
    const simple = await request(closed).get('/health').set('Origin', ADMIN);
    expect(corsHeaders(simple.headers)).toEqual([]);
    const preflight = await request(closed)
      .options('/health')
      .set('Origin', ADMIN)
      .set('Access-Control-Request-Method', 'GET');
    expect(preflight.status).toBe(403);
  });

  it('leaves a plain OPTIONS request (not a preflight) to the routes', async () => {
    const res = await request(app).options('/does-not-exist').set('Origin', 'https://evil.example');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('request id and audit context', () => {
  const probe = express();
  probe.use(requestId);
  probe.get('/context', (req, res) => {
    res.json(auditContextOf(req, res));
  });

  it('gives every response a request id', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const other = await request(app).get('/health');
    expect(other.headers['x-request-id']).not.toBe(res.headers['x-request-id']);
  });

  it('keeps a well-formed id from the caller and replaces any other', async () => {
    const kept = await request(app).get('/health').set('X-Request-Id', 'req_01JC7Q2M9X');
    expect(kept.headers['x-request-id']).toBe('req_01JC7Q2M9X');
    for (const supplied of ['has spaces', 'x'.repeat(101), '<script>']) {
      const replaced = await request(app).get('/health').set('X-Request-Id', supplied);
      expect(replaced.headers['x-request-id']).not.toBe(supplied);
      expect(replaced.headers['x-request-id']).toHaveLength(36);
    }
  });

  it('builds a context the audit contract accepts: id, address and user agent', async () => {
    const res = await request(probe)
      .get('/context')
      .set('X-Request-Id', 'req_1')
      .set('User-Agent', '  HamroPasal/1.0.0 (Android 14) ');
    expect(auditContextSchema.safeParse(res.body).success).toBe(true);
    expect(res.body).toMatchObject({
      request_id: 'req_1',
      user_agent: 'HamroPasal/1.0.0 (Android 14)',
    });
    // The loopback peer of the test client, without the IPv4-mapped prefix.
    expect(['127.0.0.1', '::1']).toContain((res.body as { ip_address: string }).ip_address);
  });

  it('cuts a very long user agent to what the trail stores and nulls a missing one', async () => {
    const long = await request(probe).get('/context').set('User-Agent', 'x'.repeat(900));
    expect((long.body as { user_agent: string }).user_agent).toHaveLength(500);
    expect(auditContextSchema.safeParse(long.body).success).toBe(true);
    const none = await request(probe).get('/context').unset('User-Agent');
    expect((none.body as { user_agent: string | null }).user_agent).toBeNull();
  });
});
