import {
  idParamSchema,
  vendorFeedQuerySchema,
  vendorMenuQuerySchema,
  type FeedResponse,
  type VendorMenu,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';

import type { CatalogService } from '../catalog/catalog-service';
import { parseInput } from '../http/validate';
import { feedView, menuView } from './views';

/** Mounted at /api/vendors. Public: guests browse shops and menus; ordering needs a session. */
export function vendorsRouter(catalog: CatalogService): Router {
  const router = Router();

  /** Customer journey 3: LIVE vendors split by SPEC §2 serviceability, nearest first. */
  router.get('/', async (req, res) => {
    const query = parseInput(vendorFeedQuerySchema, { ...req.query });
    const body: FeedResponse = feedView(await catalog.listFeed(query));
    res.json(body);
  });

  /** A LIVE vendor's active catalogue; product ids are the ones checkout expects. */
  router.get('/:id/products', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const query = parseInput(vendorMenuQuerySchema, { ...req.query });
    const body: VendorMenu = menuView(await catalog.getMenu(id, query));
    res.json(body);
  });

  return router;
}
