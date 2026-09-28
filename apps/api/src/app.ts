import express, { type ErrorRequestHandler, type Express } from 'express';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND' });
  });

  const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
  };
  app.use(errorHandler);

  return app;
}
