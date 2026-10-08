import {
  pricingPlanCreateRequestSchema,
  pricingPlanUpdateRequestSchema,
  pricingPlanViewSchema,
  type PricingModel,
  type PricingPlanCreate,
  type PricingPlanUpdate,
  type PricingPlanView,
} from '@hamro-pasal/shared-types';

import { ApiError } from '../../api/client';
import { formatNpr } from '../../lib/format';

/**
 * The contract of GET / POST / PATCH /api/admin/pricing-plans lives in
 * `@hamro-pasal/shared-types` (`api/admin-pricing.ts`) since the API serves it (Phase 26); the
 * form's rules below are built on it. Re-exported so the screen and its tests keep one import.
 */
export { pricingPlanCreateRequestSchema, pricingPlanUpdateRequestSchema, pricingPlanViewSchema };
export type { PricingPlanCreate, PricingPlanUpdate, PricingPlanView };

/** The models in the order the form offers them. */
export const planModels = [
  'COMMISSION',
  'SUBSCRIPTION',
  'FREE',
] as const satisfies readonly PricingModel[];
export type PlanModel = PricingModel;

export const PLAN_MODEL_LABELS: Readonly<Record<PlanModel, string>> = {
  COMMISSION: 'Commission',
  SUBSCRIPTION: 'Subscription',
  FREE: 'Free',
};

/** The form's fields, as typed. `terms` is the rate, the fee or the cycles, by the model. */
export interface PlanFormValues {
  readonly name: string;
  readonly model: PlanModel;
  readonly terms: string;
  readonly isOffered: boolean;
  readonly isDefault: boolean;
}

export type PlanFormField = 'name' | 'terms' | 'isOffered' | 'isDefault';

export function emptyPlanForm(): PlanFormValues {
  return { name: '', model: 'COMMISSION', terms: '', isOffered: true, isDefault: false };
}

export function formFromPlan(plan: PricingPlanView): PlanFormValues {
  return {
    name: plan.name,
    model: plan.model,
    terms: String(termsValue(plan)),
    isOffered: plan.is_offered,
    isDefault: plan.is_default,
  };
}

function termsValue(plan: PricingPlanView): number {
  switch (plan.model) {
    case 'COMMISSION':
      return plan.commission_rate;
    case 'SUBSCRIPTION':
      return plan.monthly_fee_npr;
    case 'FREE':
      return plan.duration_cycles ?? 0;
  }
}

/** The label of the one terms field, which changes with the model. */
export const TERMS_FIELD_LABELS: Readonly<Record<PlanModel, string>> = {
  COMMISSION: 'Commission per order (%)',
  SUBSCRIPTION: 'Monthly fee (NPR)',
  FREE: 'Lasts for (Billing Cycles)',
};

const TERMS_MESSAGES: Readonly<Record<PlanModel, string>> = {
  COMMISSION: 'Enter a percentage above 0, up to 100.',
  SUBSCRIPTION: 'Enter a monthly fee above 0.',
  FREE: 'Enter a whole number of Billing Cycles, from 1 to 36.',
};

/** Changing the model empties the terms field (10 as a rate is not 10 rupees) and the default. */
export function withModel(values: PlanFormValues, model: PlanModel): PlanFormValues {
  if (values.model === model) return values;
  return { ...values, model, terms: '', isDefault: model === 'COMMISSION' && values.isDefault };
}

/** "10% commission per order" / "Rs. 1,500 per month, 0% commission" / "Free for 3 Billing Cycles". */
export function planTermsLabel(
  plan: Pick<PricingPlanView, 'model' | 'commission_rate' | 'monthly_fee_npr' | 'duration_cycles'>,
): string {
  switch (plan.model) {
    case 'COMMISSION':
      return `${String(plan.commission_rate)}% commission per order`;
    case 'SUBSCRIPTION':
      return `${formatNpr(plan.monthly_fee_npr)} per month, 0% commission`;
    case 'FREE': {
      const cycles = plan.duration_cycles ?? 0;
      return `Free for ${String(cycles)} Billing Cycle${cycles === 1 ? '' : 's'}, then the default plan`;
    }
  }
}

export interface PlanToggle {
  readonly enabled: boolean;
  /** Why the toggle is locked, or what switching it on does. */
  readonly note: string | null;
}

/**
 * The "Default plan" toggle. Exactly one plan is the default: the Commission plan a vendor falls
 * back to when its Free plan expires. So it can be switched on only for an offered Commission
 * plan, and never switched off directly: another plan is made the default instead.
 */
export function defaultToggle(
  values: Pick<PlanFormValues, 'model' | 'isOffered'>,
  editing: PricingPlanView | null,
  plans: readonly PricingPlanView[],
): PlanToggle {
  if (editing?.is_default === true) {
    return {
      enabled: false,
      note: 'This is the default plan. To change it, make another Commission plan the default.',
    };
  }
  if (values.model !== 'COMMISSION') {
    return { enabled: false, note: 'Only a Commission plan can be the default.' };
  }
  if (!values.isOffered) {
    return { enabled: false, note: 'A withdrawn plan cannot be the default.' };
  }
  const current = plans.find((plan) => plan.is_default && plan.id !== editing?.id);
  return {
    enabled: true,
    note:
      current === undefined
        ? 'Vendors whose Free plan expires move to the default plan.'
        : `Replaces “${current.name}” as the default.`,
  };
}

/** The "On offer" toggle: the default plan cannot be withdrawn. */
export function offeredToggle(editing: PricingPlanView | null): PlanToggle {
  if (editing?.is_default === true) {
    return { enabled: false, note: 'The default plan cannot be withdrawn.' };
  }
  return {
    enabled: true,
    note:
      editing === null || editing.vendor_count === 0
        ? null
        : `Withdrawing stops new selections. The ${String(editing.vendor_count)} vendor${editing.vendor_count === 1 ? '' : 's'} on it keep${editing.vendor_count === 1 ? 's' : ''} it.`,
  };
}

type Errors = Readonly<Partial<Record<PlanFormField, string>>>;

export type PlanCreateResult =
  | { readonly ok: true; readonly request: PricingPlanCreate }
  | { readonly ok: false; readonly errors: Errors };

export type PlanUpdateResult =
  | { readonly ok: true; readonly request: PricingPlanUpdate }
  | { readonly ok: false; readonly errors: Errors };

const NAME_MESSAGE = 'Enter a name of at most 80 characters.';
const NAME_TAKEN_MESSAGE = 'Another plan already has this name.';

function nameTaken(
  name: string,
  plans: readonly PricingPlanView[],
  editingId: string | null,
): boolean {
  const wanted = name.trim().toLowerCase();
  return plans.some((plan) => plan.id !== editingId && plan.name.toLowerCase() === wanted);
}

/** A typed number with at most two decimals; anything else is NaN, which the schema refuses. */
function parseNumber(text: string): number {
  const trimmed = text.trim();
  return /^\d+(\.\d{1,2})?$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** Checks a new plan with the request schema, so the screen and the server cannot disagree. */
export function validateNewPlan(
  values: PlanFormValues,
  plans: readonly PricingPlanView[],
): PlanCreateResult {
  const terms = parseNumber(values.terms);
  const parsed = pricingPlanCreateRequestSchema.safeParse({
    name: values.name,
    model: values.model,
    commission_rate: values.model === 'COMMISSION' ? terms : 0,
    monthly_fee_npr: values.model === 'SUBSCRIPTION' ? terms : 0,
    duration_cycles: values.model === 'FREE' ? terms : null,
    is_offered: values.isOffered,
    is_default: values.isDefault,
  });
  const errors: Partial<Record<PlanFormField, string>> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      switch (issue.path[0]) {
        case 'name':
          errors.name = NAME_MESSAGE;
          break;
        case 'commission_rate':
        case 'monthly_fee_npr':
        case 'duration_cycles':
          errors.terms = TERMS_MESSAGES[values.model];
          break;
        case 'is_default':
          errors.isDefault = 'Only a Commission plan that is on offer can be the default.';
          break;
        default:
          break;
      }
    }
  }
  if (errors.name === undefined && nameTaken(values.name, plans, null)) {
    errors.name = NAME_TAKEN_MESSAGE;
  }
  if (parsed.success && Object.keys(errors).length === 0) {
    return { ok: true, request: parsed.data };
  }
  return { ok: false, errors };
}

/**
 * Checks an edit. Only the name and the two toggles are sent: the model and the terms of an
 * existing plan are locked, whatever the form holds.
 */
export function validatePlanEdit(
  values: PlanFormValues,
  editing: PricingPlanView,
  plans: readonly PricingPlanView[],
): PlanUpdateResult {
  const parsed = pricingPlanUpdateRequestSchema.safeParse({
    name: values.name,
    is_offered: values.isOffered,
    is_default: values.isDefault,
  });
  const errors: Partial<Record<PlanFormField, string>> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      if (issue.path[0] === 'name') errors.name = NAME_MESSAGE;
      if (issue.path[0] === 'is_offered') errors.isOffered = 'The default plan must stay on offer.';
    }
  }
  if (errors.name === undefined && nameTaken(values.name, plans, editing.id)) {
    errors.name = NAME_TAKEN_MESSAGE;
  }
  if (values.isDefault && editing.model !== 'COMMISSION') {
    errors.isDefault = 'Only a Commission plan can be the default.';
  }
  if (!values.isDefault && editing.is_default) {
    errors.isDefault = 'Make another Commission plan the default instead.';
  }
  if (parsed.success && Object.keys(errors).length === 0) {
    return { ok: true, request: parsed.data };
  }
  return { ok: false, errors };
}

/** Commission plans first (the default at the top), then Subscription, then Free; by name within. */
export function planRows(plans: readonly PricingPlanView[]): PricingPlanView[] {
  return [...plans].sort(
    (a, b) =>
      planModels.indexOf(a.model) - planModels.indexOf(b.model) ||
      Number(b.is_default) - Number(a.is_default) ||
      a.name.localeCompare(b.name),
  );
}

/** A refused save, placed on the field it is about, or on the form when no field can fix it. */
export interface PlanSaveError {
  readonly field: PlanFormField | null;
  readonly message: string;
}

/**
 * The server's refusals of POST / PATCH /api/admin/pricing-plans. The form checks the same rules
 * first, but against the list it loaded: another admin may have changed the plans meanwhile.
 */
export function planSaveError(error: unknown, mode: 'create' | 'edit'): PlanSaveError {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'PRICING_PLAN_NAME_TAKEN':
        return { field: 'name', message: NAME_TAKEN_MESSAGE };
      case 'DEFAULT_PLAN_REQUIRED':
        return {
          field: 'isDefault',
          message:
            mode === 'create'
              ? 'There is no default plan yet: the first plan must be the default.'
              : 'A default plan is required. Make another Commission plan the default instead.',
        };
      case 'DEFAULT_PLAN_NOT_COMMISSION':
        return { field: 'isDefault', message: 'Only a Commission plan can be the default.' };
      case 'PRICING_PLAN_NOT_FOUND':
        return { field: null, message: 'This plan no longer exists. Close and refresh the list.' };
      case 'VALIDATION_FAILED':
        return { field: null, message: 'The server refused this plan. Check the fields.' };
      case 'NETWORK_ERROR':
        return { field: null, message: 'The API cannot be reached. Try again.' };
      default:
        break;
    }
  }
  return { field: null, message: 'The plan could not be saved. Try again.' };
}
