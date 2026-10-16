import {
  exportJobResponseSchema,
  type AdminExportRequest,
  type ExportJobView,
  adminNotificationListResponseSchema,
  adminNotificationSentResponseSchema,
  adminVendorSearchResponseSchema,
  type AdminNotificationListResponseBody,
  type AdminNotificationRequest,
  type AdminNotificationSentResponseBody,
  type AdminVendorSearchResponseBody,
  adminAdProductListResponseSchema,
  adminAdProductResponseSchema,
  adminAuditLogListResponseSchema,
  adminCampaignListResponseSchema,
  adminCampaignResponseSchema,
  adminCategoryListResponseSchema,
  adminCategoryResponseSchema,
  adminComplianceVendorListResponseSchema,
  adminDeadLetterListResponseSchema,
  adminDeadLetterRetryResponseSchema,
  adminModelChangeDecisionResponseSchema,
  adminModelChangeRequestListResponseSchema,
  adminPayoutDecisionResponseSchema,
  adminPayoutListResponseSchema,
  adminPricingPlanListResponseSchema,
  adminPricingPlanResponseSchema,
  adminProductListResponseSchema,
  adminProductResponseSchema,
  adminPromotionListResponseSchema,
  adminPromotionResponseSchema,
  adminSettlementListResponseSchema,
  adminVendorListResponseSchema,
  adminVendorOverrideResponseSchema,
  categoryListResponseSchema,
  logisticsSettingsViewSchema,
  otpSendResponseSchema,
  otpVerifyResponseSchema,
  panVerificationResponseSchema,
  payoutRequestResponseSchema,
  PRODUCT_IMAGE_FILE_FIELD,
  PROMOTION_IMAGE_FILE_FIELD,
  promotionImageUploadResponseSchema,
  settlementPayoutResponseSchema,
  vendorFinanceLedgerResponseSchema,
  vendorProductListResponseSchema,
  vendorProductResponseSchema,
  type AdminAdProductListResponseBody,
  type AdminAdProductResponseBody,
  type AdminAuditLogListResponseBody,
  type AdminCampaignListResponseBody,
  type AdminCampaignResponseBody,
  type AdminCategoryListResponseBody,
  type AdminCategoryResponseBody,
  type AdminCategoryWriteRequest,
  type AdminComplianceVendorListResponseBody,
  type AdminDeadLetterListResponseBody,
  type AdminDeadLetterRetryResponseBody,
  type AdminModelChangeDecisionResponseBody,
  type AdminModelChangeRequestListResponseBody,
  type AdminPayoutDecisionResponseBody,
  type AdminPayoutListResponseBody,
  type AdminPricingPlanListResponseBody,
  type AdminPricingPlanResponseBody,
  type AdminProductListResponseBody,
  type AdminProductResponseBody,
  type AdminPromotionListResponseBody,
  type AdminPromotionResponseBody,
  type AdminSettlementListResponseBody,
  type AdminVendorListResponseBody,
  type AdminVendorOverrideResponseBody,
  type AdProductCreate,
  type AdProductUpdate,
  type CampaignWrite,
  type CategoryListResponseBody,
  type DeadLetterStatus,
  type LogisticsSettingsView,
  type LogisticsSettingsWrite,
  type OtpSendResponseBody,
  type OtpVerifyResponseBody,
  type PanVerificationResponseBody,
  type PayoutRequestResponseBody,
  type PayoutStatus,
  type PayoutTransferState,
  type PricingPlanCreate,
  type PricingPlanUpdate,
  type PromotionImageUploadResponseBody,
  type PromotionWrite,
  type SettlementPayoutRequest,
  type SettlementPayoutResponseBody,
  type VendorFinanceLedgerResponseBody,
  type VendorProductListResponseBody,
  type VendorProductResponseBody,
  type VendorProductUpdateRequest,
} from '@hamro-pasal/shared-types';
import { z } from 'zod';

import { ApiError, CLIENT_ERROR_CODES, type ApiClient } from './client';

/**
 * The endpoints this web app calls: sign-in, the dashboard's (under /api/admin, SUPER_ADMIN only)
 * and, since Phase 19, the Vendor Portal's (under /api/vendor/products, VENDOR only).
 */
/** What a data export request answered: the file itself, or the queued job. */
export type ExportAnswer =
  | {
      readonly kind: 'FILE';
      readonly file: Blob;
      readonly fileName: string;
      readonly rowCount: number | null;
    }
  | { readonly kind: 'QUEUED'; readonly job: ExportJobView };

export interface AdminApi {
  sendOtp(phone: string): Promise<OtpSendResponseBody>;
  /** A Super Admin's refresh token arrives as an HttpOnly cookie, not in this body. */
  verifyOtp(phone: string, code: string): Promise<OtpVerifyResponseBody>;
  /** The silent refresh on page load (see ApiClient.restoreSession). */
  restoreSession(): Promise<boolean>;
  /** Clears the refresh cookie on the server; the caller then forgets the access token. */
  logout(): Promise<void>;
  listDeadLetters(query: {
    status?: DeadLetterStatus | undefined;
    cursor?: string | undefined;
  }): Promise<AdminDeadLetterListResponseBody>;
  retryDeadLetter(id: string): Promise<AdminDeadLetterRetryResponseBody>;
  listVendors(): Promise<AdminVendorListResponseBody>;
  /**
   * Step 7.5: shops by Vendor Code (or its prefix / number) or by name (similarity). Every result
   * carries its Vendor Code, shown next to the name.
   */
  searchVendors(q: string): Promise<AdminVendorSearchResponseBody>;
  /** Step 7.5: a push to 1–500 shops or to all customers; 202 with the recipient count. */
  sendNotification(input: AdminNotificationRequest): Promise<AdminNotificationSentResponseBody>;
  /** Step 7.5: what Super Admins sent, newest first, with the push outcome. */
  listNotifications(cursor?: string): Promise<AdminNotificationListResponseBody>;
  /**
   * Step 7.6: a data export. At most 5 000 rows come back as the CSV file itself; more are queued
   * and emailed to the admin (the answer is then the job).
   */
  requestExport(input: AdminExportRequest): Promise<ExportAnswer>;
  /** Step 7.6: a queued export's status. */
  getExport(id: string): Promise<ExportJobView>;
  overrideVendor(
    id: string,
    action: 'SUSPEND' | 'RESTORE' | 'REACTIVATE',
  ): Promise<AdminVendorOverrideResponseBody>;
  /** Phase 17: the whole taxonomy in tree order, inactive categories included. */
  listCategories(): Promise<AdminCategoryListResponseBody>;
  createCategory(input: AdminCategoryWriteRequest): Promise<AdminCategoryResponseBody>;
  /** PUT: replaces every editable field of the category. */
  updateCategory(id: string, input: AdminCategoryWriteRequest): Promise<AdminCategoryResponseBody>;
  deleteCategory(id: string): Promise<void>;
  listProducts(query: {
    vendorId?: string | undefined;
    cursor?: string | undefined;
  }): Promise<AdminProductListResponseBody>;
  setProductActive(id: string, isActive: boolean): Promise<AdminProductResponseBody>;
  /** Phase 22: vendors' payout requests, newest first. */
  listPayouts(query: {
    status?: PayoutStatus | undefined;
    /** Phase 30: only payouts whose bank transfer is in this state. */
    transferState?: PayoutTransferState | undefined;
    cursor?: string | undefined;
  }): Promise<AdminPayoutListResponseBody>;
  /** Phase 30: the bank transfer of an automated payout was made; records its reference. */
  finalizePayout(id: string, bankReference: string): Promise<AdminPayoutDecisionResponseBody>;
  /** Phase 30: the bank transfer could not be made; the amount returns to the vendor's wallet. */
  failPayout(id: string, reason: string | null): Promise<AdminPayoutDecisionResponseBody>;
  /** Records the bank transfer that paid the request (the amount was held when it was requested). */
  approvePayout(id: string, bankReference: string): Promise<AdminPayoutDecisionResponseBody>;
  /** Returns the held amount to the vendor's wallet. */
  rejectPayout(id: string, reason: string | null): Promise<AdminPayoutDecisionResponseBody>;
  /** Phase 26: the two delivery mode switches, the platform fee and the LIVE shops on each mode. */
  getLogisticsSettings(): Promise<LogisticsSettingsView>;
  /** PUT: the three settings. Both modes off is the Emergency Stop. Answers the settings as stored. */
  updateLogisticsSettings(input: LogisticsSettingsWrite): Promise<LogisticsSettingsView>;
  /** Phase 26: every vendor's PAN standing, worst first. */
  listComplianceVendors(): Promise<AdminComplianceVendorListResponseBody>;
  /** No body. Stamps the check on a PAN on file; a repeat keeps the first stamp. Never changes `status`. */
  verifyVendorPan(id: string): Promise<PanVerificationResponseBody>;
  /** Phase 26: every pricing plan, withdrawn ones included. */
  listPricingPlans(): Promise<AdminPricingPlanListResponseBody>;
  createPricingPlan(input: PricingPlanCreate): Promise<AdminPricingPlanResponseBody>;
  /** PATCH: the name and the two toggles, all three sent. A plan's model and terms never change. */
  updatePricingPlan(id: string, input: PricingPlanUpdate): Promise<AdminPricingPlanResponseBody>;
  /** Phase 26: Model B shops the platform holds money for, each with its primary bank account. */
  listSettlements(): Promise<AdminSettlementListResponseBody>;
  /**
   * Records a payout the admin made by bank transfer. `idempotency_key` is one per attempt:
   * resending it answers the stored payout (`replayed`), never a second one.
   */
  processSettlementPayout(
    vendorId: string,
    input: SettlementPayoutRequest,
  ): Promise<SettlementPayoutResponseBody>;
  /**
   * Phase 26: one page of the audit trail, newest first; `cursor` is the previous page's
   * `next_cursor`. READ ONLY: the trail has no write route and this client has no write method.
   */
  listAuditLogs(query: {
    action?: string | undefined;
    entityType?: string | undefined;
    cursor?: string | undefined;
  }): Promise<AdminAuditLogListResponseBody>;
  /** Phase 26: every platform campaign with its terms version and live opt-in count. */
  listCampaigns(): Promise<AdminCampaignListResponseBody>;
  createCampaign(input: CampaignWrite): Promise<AdminCampaignResponseBody>;
  /** PUT: replaces every field. The server raises `terms_version` itself when a term changed. */
  updateCampaign(id: string, input: CampaignWrite): Promise<AdminCampaignResponseBody>;
  /** Phase 26: the Ad Marketplace price list. */
  listAdProducts(): Promise<AdminAdProductListResponseBody>;
  createAdProduct(input: AdProductCreate): Promise<AdminAdProductResponseBody>;
  /** PATCH: the name and "on sale" only. A product's terms never change. */
  updateAdProduct(id: string, input: AdProductUpdate): Promise<AdminAdProductResponseBody>;
  /** Phase 26: every Home promotion, hidden and ended ones included. */
  listPromotions(): Promise<AdminPromotionListResponseBody>;
  createPromotion(input: PromotionWrite): Promise<AdminPromotionResponseBody>;
  /** PUT: replaces every field. */
  updatePromotion(id: string, input: PromotionWrite): Promise<AdminPromotionResponseBody>;
  deletePromotion(id: string): Promise<void>;
  /**
   * Phase 34. multipart/form-data: the file as the one `image` part. Answers the stored image's
   * public URL, to send as a promotion's `image_url`.
   */
  uploadPromotionImage(file: File): Promise<PromotionImageUploadResponseBody>;
  /** An uploaded image no promotion ended up using. Refused (409) while one uses it. */
  discardPromotionImage(url: string): Promise<void>;
  /** Phase 34: the PAN document a vendor uploaded (the bucket is private: read through the API). */
  getVendorPanDocument(vendorId: string): Promise<Blob>;
  /** Phase 27: vendors' settlement model change requests, pending first. */
  listModelChangeRequests(): Promise<AdminModelChangeRequestListResponseBody>;
  /** No body: the shop moves to the model it asked for. An admin cannot name another. */
  approveModelChangeRequest(id: string): Promise<AdminModelChangeDecisionResponseBody>;
  /** `reason` is shown to the vendor; null is none. */
  rejectModelChangeRequest(
    id: string,
    reason: string | null,
  ): Promise<AdminModelChangeDecisionResponseBody>;

  /*
   * Phase 19, the Vendor Portal (VENDOR only): the signed-in vendor's own shop under
   * /api/vendor/products. The server takes the shop from the token; none of these names one.
   */

  /** The active taxonomy (public), for the category picker. */
  listActiveCategories(): Promise<CategoryListResponseBody>;
  listOwnProducts(query: { cursor?: string | undefined }): Promise<VendorProductListResponseBody>;
  /** PUT: replaces the details; the stock is untouched, the photos only when listed. */
  updateOwnProduct(
    id: string,
    input: VendorProductUpdateRequest,
  ): Promise<VendorProductResponseBody>;
  /** DELETE: hides the product from customers (a soft delete). */
  hideOwnProduct(id: string): Promise<void>;
  setOwnProductStock(id: string, stockQuantity: number): Promise<VendorProductResponseBody>;
  /** multipart/form-data: every file as one `images` part. */
  uploadOwnProductImages(id: string, files: readonly File[]): Promise<VendorProductResponseBody>;
  /** Phase 22: the shop's balance, reconciled orders and payout requests. */
  getOwnFinanceLedger(): Promise<VendorFinanceLedgerResponseBody>;
  /** `idempotencyKey` is one per withdrawal: resending it never holds the amount twice. */
  requestOwnPayout(amountNpr: number, idempotencyKey: string): Promise<PayoutRequestResponseBody>;
}

export function createAdminApi(client: ApiClient): AdminApi {
  return {
    sendOtp: (phone) =>
      client.publicRequest({
        method: 'POST',
        path: '/api/auth/otp/send',
        schema: otpSendResponseSchema,
        body: { phone },
      }),
    verifyOtp: (phone, code) =>
      client.publicRequest({
        method: 'POST',
        path: '/api/auth/otp/verify',
        schema: otpVerifyResponseSchema,
        body: { phone, code },
      }),
    restoreSession: () => client.restoreSession(),
    logout: async () => {
      // 204 No Content: the client reads an empty body as null.
      await client.publicRequest({ method: 'POST', path: '/api/auth/logout', schema: z.null() });
    },
    listDeadLetters: ({ status, cursor }) =>
      client.request({
        method: 'GET',
        path: '/api/admin/dlq',
        schema: adminDeadLetterListResponseSchema,
        query: { status, cursor },
      }),
    retryDeadLetter: (id) =>
      client.request({
        method: 'POST',
        path: `/api/admin/dlq/${encodeURIComponent(id)}/retry`,
        schema: adminDeadLetterRetryResponseSchema,
      }),
    listVendors: () =>
      client.request({
        method: 'GET',
        path: '/api/admin/vendors',
        schema: adminVendorListResponseSchema,
      }),
    overrideVendor: (id, action) =>
      client.request({
        method: 'POST',
        path: `/api/admin/vendors/${encodeURIComponent(id)}/${action === 'SUSPEND' ? 'suspend' : action === 'RESTORE' ? 'restore' : 'reactivate'}`,
        schema: adminVendorOverrideResponseSchema,
      }),
    listCategories: () =>
      client.request({
        method: 'GET',
        path: '/api/admin/categories',
        schema: adminCategoryListResponseSchema,
      }),
    createCategory: (input) =>
      client.request({
        method: 'POST',
        path: '/api/admin/categories',
        schema: adminCategoryResponseSchema,
        body: input,
      }),
    updateCategory: (id, input) =>
      client.request({
        method: 'PUT',
        path: `/api/admin/categories/${encodeURIComponent(id)}`,
        schema: adminCategoryResponseSchema,
        body: input,
      }),
    deleteCategory: async (id) => {
      // 204 No Content: the client reads an empty body as null.
      await client.request({
        method: 'DELETE',
        path: `/api/admin/categories/${encodeURIComponent(id)}`,
        schema: z.null(),
      });
    },
    listProducts: ({ vendorId, cursor }) =>
      client.request({
        method: 'GET',
        path: '/api/admin/products',
        schema: adminProductListResponseSchema,
        query: { vendor_id: vendorId, cursor },
      }),
    setProductActive: (id, isActive) =>
      client.request({
        method: 'PATCH',
        path: `/api/admin/products/${encodeURIComponent(id)}/active`,
        schema: adminProductResponseSchema,
        body: { is_active: isActive },
      }),
    listPayouts: ({ status, transferState, cursor }) =>
      client.request({
        method: 'GET',
        path: '/api/admin/finance/payouts',
        schema: adminPayoutListResponseSchema,
        query: { status, transfer_state: transferState, cursor },
      }),
    finalizePayout: (id, bankReference) =>
      client.request({
        method: 'POST',
        path: `/api/admin/finance/payouts/${encodeURIComponent(id)}/finalize`,
        schema: adminPayoutDecisionResponseSchema,
        body: { bank_reference: bankReference },
      }),
    failPayout: (id, reason) =>
      client.request({
        method: 'POST',
        path: `/api/admin/finance/payouts/${encodeURIComponent(id)}/fail`,
        schema: adminPayoutDecisionResponseSchema,
        body: { reason },
      }),
    approvePayout: (id, bankReference) =>
      client.request({
        method: 'POST',
        path: `/api/admin/finance/payouts/${encodeURIComponent(id)}/approve`,
        schema: adminPayoutDecisionResponseSchema,
        body: { bank_reference: bankReference },
      }),
    rejectPayout: (id, reason) =>
      client.request({
        method: 'POST',
        path: `/api/admin/finance/payouts/${encodeURIComponent(id)}/reject`,
        schema: adminPayoutDecisionResponseSchema,
        body: { reason },
      }),
    getLogisticsSettings: () =>
      client.request({
        method: 'GET',
        path: '/api/admin/settings/logistics',
        schema: logisticsSettingsViewSchema,
      }),
    updateLogisticsSettings: (input) =>
      client.request({
        method: 'PUT',
        path: '/api/admin/settings/logistics',
        schema: logisticsSettingsViewSchema,
        body: input,
      }),
    listComplianceVendors: () =>
      client.request({
        method: 'GET',
        path: '/api/admin/compliance/vendors',
        schema: adminComplianceVendorListResponseSchema,
      }),
    verifyVendorPan: (id) =>
      client.request({
        method: 'POST',
        path: `/api/admin/vendors/${encodeURIComponent(id)}/pan-verification`,
        schema: panVerificationResponseSchema,
      }),
    listPricingPlans: () =>
      client.request({
        method: 'GET',
        path: '/api/admin/pricing-plans',
        schema: adminPricingPlanListResponseSchema,
      }),
    createPricingPlan: (input) =>
      client.request({
        method: 'POST',
        path: '/api/admin/pricing-plans',
        schema: adminPricingPlanResponseSchema,
        body: input,
      }),
    updatePricingPlan: (id, input) =>
      client.request({
        method: 'PATCH',
        path: `/api/admin/pricing-plans/${encodeURIComponent(id)}`,
        schema: adminPricingPlanResponseSchema,
        body: input,
      }),
    searchVendors: (q) =>
      client.request({
        method: 'GET',
        path: '/api/admin/vendors/search',
        schema: adminVendorSearchResponseSchema,
        query: { q },
      }),
    sendNotification: (input) =>
      client.request({
        method: 'POST',
        path: '/api/admin/notifications',
        schema: adminNotificationSentResponseSchema,
        body: input,
      }),
    listNotifications: (cursor) =>
      client.request({
        method: 'GET',
        path: '/api/admin/notifications',
        schema: adminNotificationListResponseSchema,
        query: { cursor },
      }),
    requestExport: async (input) => {
      const answer = await client.postForFile('/api/admin/exports', input);
      if (answer.status === 202) {
        const parsed = exportJobResponseSchema.safeParse(
          JSON.parse(await answer.body.text()) as unknown,
        );
        if (!parsed.success) {
          throw new ApiError(
            answer.status,
            CLIENT_ERROR_CODES.UNEXPECTED_RESPONSE,
            'Unexpected export answer',
          );
        }
        return { kind: 'QUEUED', job: parsed.data.job };
      }
      return {
        kind: 'FILE',
        file: answer.body,
        fileName: answer.fileName ?? 'hamro-pasal-export.csv',
        rowCount: null,
      };
    },
    getExport: async (id) =>
      (
        await client.request({
          method: 'GET',
          path: `/api/admin/exports/${encodeURIComponent(id)}`,
          schema: exportJobResponseSchema,
        })
      ).job,
    listSettlements: () =>
      client.request({
        method: 'GET',
        path: '/api/admin/finance/settlements',
        schema: adminSettlementListResponseSchema,
      }),
    processSettlementPayout: (vendorId, input) =>
      client.request({
        method: 'POST',
        path: `/api/admin/finance/settlements/${encodeURIComponent(vendorId)}/payout`,
        schema: settlementPayoutResponseSchema,
        body: input,
      }),
    listAuditLogs: ({ action, entityType, cursor }) =>
      client.request({
        method: 'GET',
        path: '/api/admin/audit-logs',
        schema: adminAuditLogListResponseSchema,
        query: { action, entity_type: entityType, cursor },
      }),
    listCampaigns: () =>
      client.request({
        method: 'GET',
        path: '/api/admin/campaigns',
        schema: adminCampaignListResponseSchema,
      }),
    createCampaign: (input) =>
      client.request({
        method: 'POST',
        path: '/api/admin/campaigns',
        schema: adminCampaignResponseSchema,
        body: input,
      }),
    updateCampaign: (id, input) =>
      client.request({
        method: 'PUT',
        path: `/api/admin/campaigns/${encodeURIComponent(id)}`,
        schema: adminCampaignResponseSchema,
        body: input,
      }),
    listAdProducts: () =>
      client.request({
        method: 'GET',
        path: '/api/admin/ads/products',
        schema: adminAdProductListResponseSchema,
      }),
    createAdProduct: (input) =>
      client.request({
        method: 'POST',
        path: '/api/admin/ads/products',
        schema: adminAdProductResponseSchema,
        body: input,
      }),
    updateAdProduct: (id, input) =>
      client.request({
        method: 'PATCH',
        path: `/api/admin/ads/products/${encodeURIComponent(id)}`,
        schema: adminAdProductResponseSchema,
        body: input,
      }),
    listPromotions: () =>
      client.request({
        method: 'GET',
        path: '/api/admin/promotions',
        schema: adminPromotionListResponseSchema,
      }),
    createPromotion: (input) =>
      client.request({
        method: 'POST',
        path: '/api/admin/promotions',
        schema: adminPromotionResponseSchema,
        body: input,
      }),
    updatePromotion: (id, input) =>
      client.request({
        method: 'PUT',
        path: `/api/admin/promotions/${encodeURIComponent(id)}`,
        schema: adminPromotionResponseSchema,
        body: input,
      }),
    listModelChangeRequests: () =>
      client.request({
        method: 'GET',
        path: '/api/admin/settlement-model-requests',
        schema: adminModelChangeRequestListResponseSchema,
      }),
    approveModelChangeRequest: (id) =>
      client.request({
        method: 'POST',
        path: `/api/admin/settlement-model-requests/${encodeURIComponent(id)}/approve`,
        schema: adminModelChangeDecisionResponseSchema,
      }),
    rejectModelChangeRequest: (id, reason) =>
      client.request({
        method: 'POST',
        path: `/api/admin/settlement-model-requests/${encodeURIComponent(id)}/reject`,
        schema: adminModelChangeDecisionResponseSchema,
        body: { reason },
      }),
    uploadPromotionImage: (file) => {
      const form = new FormData();
      form.append(PROMOTION_IMAGE_FILE_FIELD, file, file.name);
      return client.request({
        method: 'POST',
        path: '/api/admin/promotions/image',
        schema: promotionImageUploadResponseSchema,
        body: form,
      });
    },
    discardPromotionImage: async (url) => {
      await client.request({
        method: 'DELETE',
        path: '/api/admin/promotions/image',
        schema: z.null(),
        body: { url },
      });
    },
    getVendorPanDocument: (vendorId) =>
      client.download(`/api/admin/vendors/${encodeURIComponent(vendorId)}/pan-document`),
    deletePromotion: async (id) => {
      // 204 No Content: the client reads an empty body as null.
      await client.request({
        method: 'DELETE',
        path: `/api/admin/promotions/${encodeURIComponent(id)}`,
        schema: z.null(),
      });
    },
    listActiveCategories: () =>
      client.publicRequest({
        method: 'GET',
        path: '/api/categories',
        schema: categoryListResponseSchema,
      }),
    listOwnProducts: ({ cursor }) =>
      client.request({
        method: 'GET',
        path: '/api/vendor/products',
        schema: vendorProductListResponseSchema,
        query: { cursor },
      }),
    updateOwnProduct: (id, input) =>
      client.request({
        method: 'PUT',
        path: `/api/vendor/products/${encodeURIComponent(id)}`,
        schema: vendorProductResponseSchema,
        body: input,
      }),
    hideOwnProduct: async (id) => {
      // 204 No Content: the client reads an empty body as null.
      await client.request({
        method: 'DELETE',
        path: `/api/vendor/products/${encodeURIComponent(id)}`,
        schema: z.null(),
      });
    },
    setOwnProductStock: (id, stockQuantity) =>
      client.request({
        method: 'PATCH',
        path: `/api/vendor/products/${encodeURIComponent(id)}/stock`,
        schema: vendorProductResponseSchema,
        body: { stock_quantity: stockQuantity },
      }),
    uploadOwnProductImages: (id, files) => {
      // The client sends a FormData untouched, so the browser writes the multipart boundary.
      const form = new FormData();
      for (const file of files) form.append(PRODUCT_IMAGE_FILE_FIELD, file, file.name);
      return client.request({
        method: 'POST',
        path: `/api/vendor/products/${encodeURIComponent(id)}/images`,
        schema: vendorProductResponseSchema,
        body: form,
      });
    },
    getOwnFinanceLedger: () =>
      client.request({
        method: 'GET',
        path: '/api/vendor/finance/ledger',
        schema: vendorFinanceLedgerResponseSchema,
      }),
    requestOwnPayout: (amountNpr, idempotencyKey) =>
      client.request({
        method: 'POST',
        path: '/api/vendor/finance/payout',
        schema: payoutRequestResponseSchema,
        body: { idempotency_key: idempotencyKey, amount_npr: amountNpr },
      }),
  };
}
