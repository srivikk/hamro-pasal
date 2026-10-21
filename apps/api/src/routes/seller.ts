import {
  adminVendorCreateRequestSchema,
  idParamSchema,
  MAX_PAN_DOCUMENT_BYTES,
  PAN_DOCUMENT_FILE_FIELD,
  sellerSignupRequestSchema,
  type SellerSignupOptionsResponseBody,
  tutorialListQuerySchema,
  tutorialWriteRequestSchema,
  type AdminVendorApprovedResponseBody,
  type AdminVendorCreatedResponseBody,
  type SellerApplicationResponseBody,
  type SellerSignupResponseBody,
  type TutorialListResponseBody,
  type TutorialResponseBody,
} from '@hamro-pasal/shared-types';
import { Router, type Request, type RequestHandler } from 'express';

import { authOf } from '../http/auth';
import { auditActorOf, auditContextOf } from '../http/request-context';
import { parseInput } from '../http/validate';
import type { TutorialService } from '../tutorials/tutorial-service';
import { missingFile, singleImageUpload, storedImageOf } from '../uploads/image-upload';
import type { SellerOnboardingService } from '../vendor/seller-onboarding-service';

function userActor(req: Request) {
  const actor = auditActorOf(req);
  if (actor.kind !== 'USER') throw new Error('A signed-in caller is always a user');
  return actor;
}

/**
 * Mounted at /api/seller (step 7.7). POST /signup is public: the signup token from the Seller
 * app's sign-in proves the number. GET /application needs the vendor session it returned.
 */
export function sellerRouter(
  onboarding: SellerOnboardingService,
  vendorAuth: RequestHandler,
): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  /**
   * Public (2026-10-20): the delivery modes a new shop may choose now, so the Seller app offers only
   * those, and says registrations are paused when there is none.
   */
  router.get('/signup-options', async (_req, res) => {
    const options = await onboarding.signupOptions();
    const body: SellerSignupOptionsResponseBody = {
      self_delivery_enabled: options.selfDeliveryEnabled,
      platform_fleet_enabled: options.platformFleetEnabled,
      signups_open:
        (options.selfDeliveryEnabled || options.platformFleetEnabled) &&
        options.subscriptionPlans.length > 0,
      subscription_plans: [...options.subscriptionPlans],
    };
    res.json(body);
  });

  /** 201: the shop (SANDBOXED) and a vendor session, as POST /api/auth/otp/verify answers one. */
  router.post('/signup', async (req, res) => {
    const request = parseInput(sellerSignupRequestSchema, req.body);
    const { application, session } = await onboarding.signup(request, auditContextOf(req, res));
    const body: SellerSignupResponseBody = {
      token_type: 'Bearer',
      access_token: session.accessToken,
      access_token_expires_in: session.accessTokenExpiresIn,
      refresh_token: session.refreshToken,
      refresh_token_expires_in: session.refreshTokenExpiresIn,
      user: session.user,
      is_new_user: false,
      application,
    };
    res.status(201).json(body);
  });

  router.get('/application', vendorAuth, async (req, res) => {
    const body: SellerApplicationResponseBody = {
      application: await onboarding.application(authOf(req).userId),
    };
    res.status(200).json(body);
  });

  return router;
}

/** Mounted at /api/vendor/kyc behind vendor auth (step 7.7, vendor flow 2). */
export function vendorKycRouter(onboarding: SellerOnboardingService): Router {
  const router = Router();
  const document = singleImageUpload(PAN_DOCUMENT_FILE_FIELD, MAX_PAN_DOCUMENT_BYTES);

  /** multipart/form-data, the photo as the `document` part (as the PAN document). */
  router.post('/citizenship-document', document, async (req, res) => {
    const { file } = req;
    if (file === undefined) {
      throw missingFile(PAN_DOCUMENT_FILE_FIELD, 'A photo of the citizenship document is required');
    }
    const image = await storedImageOf(file.buffer, 'The citizenship document');
    const body: SellerApplicationResponseBody = {
      application: await onboarding.uploadCitizenshipDocument(
        userActor(req),
        image,
        auditContextOf(req, res),
      ),
    };
    res.status(200).json(body);
  });

  return router;
}

/**
 * Mounted at /api/admin behind SUPER_ADMIN auth, before the admin router: the Super Admin
 * onboards shops and approves them (step 7.7), and manages the tutorial videos (step 7.8).
 */
export function adminOnboardingRouter(
  onboarding: SellerOnboardingService,
  tutorials: TutorialService,
): Router {
  const router = Router();

  router.post('/vendors', async (req, res) => {
    const request = parseInput(adminVendorCreateRequestSchema, req.body);
    const created = await onboarding.adminCreate(
      authOf(req).userId,
      request,
      auditContextOf(req, res),
    );
    const body: AdminVendorCreatedResponseBody = {
      vendor_id: created.vendor.id,
      vendor_code: created.vendor.vendor_code,
      user_id: created.vendor.user_id,
      status: created.vendor.status,
      account_created: created.accountCreated,
      invite_sent: created.inviteSent,
    };
    res.status(201).json(body);
  });

  router.post('/vendors/:id/approve', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const vendor = await onboarding.approve(authOf(req).userId, id, auditContextOf(req, res));
    const body: AdminVendorApprovedResponseBody = { vendor_id: vendor.id, status: vendor.status };
    res.status(200).json(body);
  });

  router.get('/tutorials', async (_req, res) => {
    const body: TutorialListResponseBody = { tutorials: await tutorials.listAll() };
    res.setHeader('Cache-Control', 'no-store').status(200).json(body);
  });

  router.post('/tutorials', async (req, res) => {
    const input = parseInput(tutorialWriteRequestSchema, req.body);
    const body: TutorialResponseBody = {
      tutorial: await tutorials.create(authOf(req).userId, input, auditContextOf(req, res)),
    };
    res.status(201).json(body);
  });

  router.put('/tutorials/:id', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const input = parseInput(tutorialWriteRequestSchema, req.body);
    const body: TutorialResponseBody = {
      tutorial: await tutorials.update(authOf(req).userId, id, input, auditContextOf(req, res)),
    };
    res.status(200).json(body);
  });

  router.delete('/tutorials/:id', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    await tutorials.remove(authOf(req).userId, id, auditContextOf(req, res));
    res.status(204).end();
  });

  return router;
}

/** Mounted at /api/tutorials: public, the active videos of one app (step 7.8). */
export function tutorialsRouter(tutorials: TutorialService): Router {
  const router = Router();
  router.get('/', async (req, res) => {
    const { app } = parseInput(tutorialListQuerySchema, { ...req.query });
    const body: TutorialListResponseBody = { tutorials: await tutorials.listActive(app) };
    res.setHeader('Cache-Control', 'public, max-age=300').status(200).json(body);
  });
  return router;
}
