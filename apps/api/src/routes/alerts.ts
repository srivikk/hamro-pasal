import {
  idParamSchema,
  type AlertListResponseBody,
  type AlertResponseBody,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';

import type { AlertService } from '../account/alert-service';
import { authOf } from '../http/auth';
import { parseInput } from '../http/validate';

/**
 * Mounted at /api/me/alerts behind customer auth. Step 7.4 (SPEC core 11, Notify Me). PUT asks to
 * be told (idempotent), DELETE withdraws the request (idempotent too).
 */
export function alertsRouter(alerts: AlertService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/', async (req, res) => {
    const body: AlertListResponseBody = await alerts.list(authOf(req).userId);
    res.status(200).json(body);
  });

  router.put('/products/:id', async (req, res) => {
    const { id } = parseInput(idParamSchema, req.params);
    await alerts.addProduct(authOf(req).userId, id);
    const body: AlertResponseBody = { alerted: true };
    res.status(200).json(body);
  });

  router.delete('/products/:id', async (req, res) => {
    const { id } = parseInput(idParamSchema, req.params);
    await alerts.removeProduct(authOf(req).userId, id);
    const body: AlertResponseBody = { alerted: false };
    res.status(200).json(body);
  });

  router.put('/shops/:id', async (req, res) => {
    const { id } = parseInput(idParamSchema, req.params);
    await alerts.addShop(authOf(req).userId, id);
    const body: AlertResponseBody = { alerted: true };
    res.status(200).json(body);
  });

  router.delete('/shops/:id', async (req, res) => {
    const { id } = parseInput(idParamSchema, req.params);
    await alerts.removeShop(authOf(req).userId, id);
    const body: AlertResponseBody = { alerted: false };
    res.status(200).json(body);
  });

  return router;
}
