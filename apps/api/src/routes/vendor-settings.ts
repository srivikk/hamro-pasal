import {
  availabilityRequestSchema,
  billingChangeRequestSchema,
  openingHoursRequestSchema,
  type OpeningHoursResponseBody,
  deliverySettingsRequestSchema,
  idParamSchema,
  MAX_PAN_DOCUMENT_BYTES,
  PAN_DOCUMENT_FILE_FIELD,
  taxIdentityRequestSchema,
  type AuditActor,
  type BillingChangeResponseBody,
  type DeliverySettingsResponseBody,
  type PanDocumentUploadResponseBody,
  type TaxIdentityResponseBody,
  type TaxIdentityView,
} from '@hamro-pasal/shared-types';
import { Router, type Request } from 'express';

import { auditActorOf, auditContextOf } from '../http/request-context';
import { parseInput } from '../http/validate';
import { missingFile, singleImageUpload, storedImageOf } from '../uploads/image-upload';
import type { VendorAvailabilityService } from '../vendor/vendor-availability-service';
import type { VendorBillingService } from '../vendor/vendor-billing-service';
import type { VendorComplianceService } from '../vendor/vendor-compliance-service';
import {
  modeEnabled,
  type DeliverySettings,
  type VendorDeliverySettingsService,
} from '../vendor/vendor-delivery-settings-service';

export interface VendorSettingsServices {
  /** Step 7.3: opening hours and the Open / Closed switch. */
  readonly availability: VendorAvailabilityService;
  readonly billing: VendorBillingService;
  readonly compliance: VendorComplianceService;
  readonly deliverySettings: VendorDeliverySettingsService;
}

function deliverySettingsView({
  vendor,
  platform,
}: DeliverySettings): DeliverySettingsResponseBody {
  return {
    vendor_id: vendor.id,
    fulfillment_mode: vendor.fulfillment_mode,
    delivery_scope: vendor.delivery_scope,
    radius_km: vendor.radius_km,
    serviceable_palikas: vendor.serviceable_palikas,
    municipality_palika_string: vendor.municipality_palika_string,
    base_delivery_fee_npr: vendor.base_delivery_fee_npr,
    delivery_fee_per_km_npr: vendor.delivery_fee_per_km_npr,
    free_delivery_above_npr: vendor.free_delivery_above_npr,
    min_order_value: vendor.min_order_value,
    platform: {
      self_delivery_enabled: platform.selfDeliveryEnabled,
      platform_fleet_enabled: platform.platformFleetEnabled,
      platform_delivery_fee_npr: platform.platformDeliveryFeeNpr,
    },
    fulfillment_mode_enabled: modeEnabled(platform, vendor.fulfillment_mode),
  };
}

/** The signed-in vendor as the actor of an audited change (the router sits behind requireAuth). */
function vendorActor(req: Request): AuditActor & { kind: 'USER' } {
  const actor = auditActorOf(req);
  if (actor.kind !== 'USER') throw new Error('A signed-in caller is always a user');
  return actor;
}

/**
 * Mounted at /api/vendor behind requireAuth(VENDOR) (Phase 25): the shop's own settings. Any
 * vendor status may use it: a shop suspended for compliance must be able to save its PAN, and a
 * sandboxed one configures delivery before it goes live.
 */
export function vendorSettingsRouter({
  billing,
  compliance,
  availability,
  deliverySettings,
}: VendorSettingsServices): Router {
  const router = Router();
  const panDocument = singleImageUpload(PAN_DOCUMENT_FILE_FIELD, MAX_PAN_DOCUMENT_BYTES);
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  /** Phase 34: what the shop has on file. Whether a document was uploaded, never the document. */
  router.get('/tax-identity', async (req, res) => {
    const vendor = await compliance.taxIdentity(vendorActor(req).user_id);
    const body: TaxIdentityView = {
      vendor_id: vendor.id,
      tax_id: vendor.tax_id,
      is_vat_registered: vendor.is_vat_registered,
      legal_name: vendor.legal_name,
      registered_address: vendor.registered_address,
      status: vendor.status,
      pan_verified_at: vendor.pan_verified_at?.toISOString() ?? null,
      has_pan_document: vendor.pan_document_url !== null,
    };
    res.json(body);
  });

  /**
   * Phase 34: multipart/form-data with one `document` part, a photo of the PAN certificate (JPEG,
   * PNG or WebP by its own bytes, at most 5 MB). It is re-encoded, stored in the private bucket,
   * and takes the place of an earlier document, which is then deleted. The response never
   * carries where it is stored.
   */
  router.post('/tax-identity/document', panDocument, async (req, res) => {
    const { file } = req;
    if (file === undefined) {
      throw missingFile(PAN_DOCUMENT_FILE_FIELD, 'A photo of the PAN document is required');
    }
    const image = await storedImageOf(file.buffer, 'The PAN document');
    const { vendor, replaced, verificationCleared } = await compliance.uploadPanDocument(
      vendorActor(req),
      image,
      auditContextOf(req, res),
    );
    const body: PanDocumentUploadResponseBody = {
      vendor_id: vendor.id,
      has_pan_document: true,
      replaced,
      verification_cleared: verificationCleared,
      pan_verified_at: vendor.pan_verified_at?.toISOString() ?? null,
    };
    res.status(201).json(body);
  });

  /** Saving the PAN lifts a compliance suspension in the same transaction (SPEC core 10). */
  router.put('/tax-identity', async (req, res) => {
    const input = parseInput(taxIdentityRequestSchema, req.body);
    const { vendor, complianceSuspensionLifted, waitingInvoicesIssued, panDocumentRemoved } =
      await compliance.saveTaxIdentity(vendorActor(req), input, auditContextOf(req, res));
    const body: TaxIdentityResponseBody = {
      vendor_id: vendor.id,
      tax_id: input.tax_id,
      is_vat_registered: vendor.is_vat_registered,
      legal_name: vendor.legal_name,
      registered_address: vendor.registered_address,
      status: vendor.status,
      compliance_suspension_lifted: complianceSuspensionLifted,
      pan_verified_at: vendor.pan_verified_at?.toISOString() ?? null,
      waiting_invoices_issued: waitingInvoicesIssued,
      pan_document_removed: panDocumentRemoved,
      has_pan_document: vendor.pan_document_url !== null,
    };
    res.json(body);
  });

  // Step 7.3 (SPEC core 11): the weekly hours, and the switch over them.
  router.get('/opening-hours', async (req, res) => {
    const { vendorId, ranges } = await availability.hours(vendorActor(req).user_id);
    const body: OpeningHoursResponseBody = { vendor_id: vendorId, ranges };
    res.json(body);
  });

  router.put('/opening-hours', async (req, res) => {
    const input = parseInput(openingHoursRequestSchema, req.body);
    const { vendorId, ranges } = await availability.setHours(
      vendorActor(req),
      input.ranges,
      auditContextOf(req, res),
    );
    const body: OpeningHoursResponseBody = { vendor_id: vendorId, ranges };
    res.json(body);
  });

  router.get('/availability', async (req, res) => {
    res.json(await availability.availability(vendorActor(req).user_id));
  });

  router.put('/availability', async (req, res) => {
    const input = parseInput(availabilityRequestSchema, req.body);
    res.json(await availability.setAvailability(vendorActor(req), input, auditContextOf(req, res)));
  });

  router.get('/delivery-settings', async (req, res) => {
    res.json(deliverySettingsView(await deliverySettings.get(vendorActor(req).user_id)));
  });

  router.put('/delivery-settings', async (req, res) => {
    const input = parseInput(deliverySettingsRequestSchema, req.body);
    const settings = await deliverySettings.update(
      vendorActor(req),
      input,
      auditContextOf(req, res),
    );
    res.json(deliverySettingsView(settings));
  });

  /** Queued, not applied: it takes effect when the Billing Cycle renews (SPEC core 4). */
  router.post('/billing/changes', async (req, res) => {
    const input = parseInput(billingChangeRequestSchema, req.body);
    const change = await billing.requestChange(vendorActor(req), input, auditContextOf(req, res));
    const body: BillingChangeResponseBody = {
      change:
        change === null
          ? null
          : {
              id: change.id,
              setting: change.setting,
              current_value: change.current_value,
              requested_value: change.requested_value,
              status: change.status,
              requested_at: change.requested_at.toISOString(),
              effective_from: change.effective_from.toISOString(),
            },
    };
    res.status(change === null ? 200 : 202).json(body);
  });

  router.delete('/billing/changes/:id', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    await billing.withdrawChange(vendorActor(req), id, auditContextOf(req, res));
    res.status(204).end();
  });

  return router;
}
