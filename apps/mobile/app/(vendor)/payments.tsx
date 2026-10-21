import Ionicons from '@expo/vector-icons/Ionicons';
import {
  gatewayPaymentMethods,
  type BankAccountWrite,
  type GatewayPaymentMethod,
  type OfferedPlanView,
} from '@hamro-pasal/shared-types';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, Switch, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../../src/api/http';
import { VENDOR_PAYMENTS_ERROR_CODES } from '../../src/api/vendor-payments';
import { Button } from '../../src/components/Button';
import { KeyboardScreen } from '../../src/components/KeyboardScreen';
import {
  accountFor,
  merchantAccountState,
  methodsOf,
  pendingChangeOf,
  sameChoice,
  takesDirectPayments,
  toggle,
  upcomingChoice,
  upcomingPlanId,
  type PaymentChoice,
} from '../../src/features/vendor/payment-preferences';
import {
  useAddBankAccount,
  useBankAccountsQuery,
  useGatewayAccountsQuery,
  useRequestBillingChange,
  useSaveGatewayAccount,
  useVendorBillingQuery,
  useWithdrawBillingChange,
} from '../../src/features/vendor/useVendorPayments';
import { formatPostedAt } from '../../src/features/vendor/wallet-format';
import { useAuthStore } from '../../src/store/useAuthStore';
import { useToastStore } from '../../src/store/useToastStore';
import { colors } from '../../src/theme/colors';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-3 rounded-2xl bg-white p-4 shadow-sm">
      <Text className="text-lg font-bold text-gray-900">{title}</Text>
      {children}
    </View>
  );
}

function Input({
  testID,
  label,
  value,
  onChangeText,
  secure = false,
}: {
  testID: string;
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  secure?: boolean;
}) {
  return (
    <View className="gap-1">
      <Text className="text-sm font-semibold text-gray-700">{label}</Text>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
        className="min-h-12 rounded-xl border border-gray-300 bg-white px-4 text-base text-gray-900"
      />
    </View>
  );
}

function SwitchRow({
  testID,
  label,
  hint,
  value,
  onToggle,
}: {
  testID: string;
  label: string;
  hint: string;
  value: boolean;
  onToggle: () => void;
}) {
  return (
    <View className="flex-row items-center gap-3">
      <View className="flex-1">
        <Text className="text-base font-semibold text-gray-900">{label}</Text>
        <Text className="text-sm text-gray-500">{hint}</Text>
      </View>
      <Switch
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onValueChange={onToggle}
        trackColor={{ true: colors.success, false: colors.inactive }}
      />
    </View>
  );
}

const EMPTY_BANK: BankAccountWrite = {
  bank_name: '',
  branch_name: '',
  account_name: '',
  account_number: '',
  routing_or_swift_code: null,
  is_primary: false,
};

/**
 * 2026-10-21 (SPEC core 4, 5 and 9): how the shop is paid. Opened from Shop settings.
 *
 * - Plan: the active plan and the Subscription plans the shop may switch to. Commission and Free
 *   plans are assigned by a Super Admin, so they are never offered here.
 * - Payment methods: Cash on Delivery and Prepayment (eSewa and Khalti) as two switches. A change
 *   is queued for the next Billing Cycle, as SPEC core 4 requires, and can be withdrawn until then.
 * - Model C shops: their own eSewa / Khalti merchant accounts, which customers pay directly once a
 *   Super Admin has verified them. The secret is sent once and never shown again.
 * - Bank accounts: where the platform sends the shop's payouts.
 *
 * Cycle dues (a cycle that ended below 0) are shown first: unpaid by the due date, the shop is
 * suspended.
 */
export default function VendorPaymentsScreen() {
  const { t } = useTranslation();
  const locale = useAuthStore((state) => state.locale);
  const toast = useToastStore((store) => store.show);
  const billing = useVendorBillingQuery();
  const direct = billing.data !== undefined && takesDirectPayments(billing.data);
  const gateways = useGatewayAccountsQuery(direct);
  const banks = useBankAccountsQuery();
  const requestChange = useRequestBillingChange();
  const withdraw = useWithdrawBillingChange();
  const saveGateway = useSaveGatewayAccount();
  const addBank = useAddBankAccount();

  const [choiceDraft, setChoiceDraft] = useState<PaymentChoice | null>(null);
  const [planDraft, setPlanDraft] = useState<string | null>(null);
  const [merchant, setMerchant] = useState<
    Record<GatewayPaymentMethod, { code: string; secret: string }>
  >({ ESEWA: { code: '', secret: '' }, KHALTI: { code: '', secret: '' } });
  const [bank, setBank] = useState<BankAccountWrite>(EMPTY_BANK);

  const failed = (error: unknown): void => {
    const code = error instanceof ApiError ? error.code : null;
    const key =
      code === VENDOR_PAYMENTS_ERROR_CODES.adminOnlyPlan
        ? 'vendorPayments.errors.adminOnlyPlan'
        : code === VENDOR_PAYMENTS_ERROR_CODES.merchantTaken
          ? 'vendorPayments.errors.merchantTaken'
          : code === VENDOR_PAYMENTS_ERROR_CODES.invalid
            ? 'vendorPayments.errors.invalid'
            : 'vendorPayments.errors.failed';
    toast(t(key), 'error');
  };

  if (billing.data === undefined) {
    return (
      <KeyboardScreen testID="vendor-payments">
        {billing.isError ? (
          <View className="gap-3">
            <Text className="text-base text-gray-700">{t('vendorPayments.loadFailed')}</Text>
            <Button
              testID="payments-retry"
              label={t('common.retry')}
              variant="secondary"
              onPress={() => {
                void billing.refetch();
              }}
            />
          </View>
        ) : (
          <ActivityIndicator testID="payments-loading" color={colors.brand} />
        )}
      </KeyboardScreen>
    );
  }

  const view = billing.data;
  const nextCycle =
    view.billing_cycle_ends_at === null ? null : formatPostedAt(view.billing_cycle_ends_at, locale);
  const upcoming = upcomingChoice(view);
  const choice = choiceDraft ?? upcoming;
  const pendingMethods = pendingChangeOf(view, 'PAYMENT_METHODS');
  const pendingPlan = pendingChangeOf(view, 'PRICING_PLAN');
  const queuedPlanId = upcomingPlanId(view);
  const activePlanId = view.pricing_plan?.id ?? null;
  const selectedPlanId = planDraft ?? queuedPlanId ?? activePlanId;

  const planTerms = (plan: OfferedPlanView): string =>
    plan.model === 'SUBSCRIPTION'
      ? t('vendorPayments.terms.SUBSCRIPTION', { amount: plan.monthly_fee_npr })
      : plan.model === 'COMMISSION'
        ? t('vendorPayments.terms.COMMISSION', { rate: plan.commission_rate })
        : t('vendorPayments.terms.FREE');

  const queue = (change: Parameters<typeof requestChange.mutate>[0], done: () => void): void => {
    requestChange.mutate(change, {
      onSuccess: () => {
        done();
        toast(t('vendorPayments.queued'), 'success');
      },
      onError: failed,
    });
  };

  const sendMethods = (): void => {
    const methods = methodsOf(choice);
    if (methods === null) return;
    queue({ setting: 'PAYMENT_METHODS', value: { methods } }, () => {
      setChoiceDraft(null);
    });
  };

  const sendPlan = (): void => {
    if (selectedPlanId === null) return;
    queue({ setting: 'PRICING_PLAN', value: { pricing_plan_id: selectedPlanId } }, () => {
      setPlanDraft(null);
    });
  };

  const withdrawChange = (id: string): void => {
    withdraw.mutate(id, {
      onSuccess: () => {
        setChoiceDraft(null);
        setPlanDraft(null);
        toast(t('vendorPayments.withdrawn'), 'success');
      },
      onError: failed,
    });
  };

  const sendMerchant = (gateway: GatewayPaymentMethod): void => {
    const { code, secret } = merchant[gateway];
    saveGateway.mutate(
      { gateway, draft: { merchant_code: code, secret_key: secret } },
      {
        onSuccess: () => {
          setMerchant((current) => ({ ...current, [gateway]: { code: '', secret: '' } }));
          toast(t('vendorPayments.merchantSaved'), 'success');
        },
        onError: failed,
      },
    );
  };

  const sendBank = (): void => {
    const routing = bank.routing_or_swift_code?.trim() ?? '';
    addBank.mutate(
      { ...bank, routing_or_swift_code: routing === '' ? null : routing },
      {
        onSuccess: () => {
          setBank(EMPTY_BANK);
          toast(t('vendorPayments.bankSaved'), 'success');
        },
        onError: failed,
      },
    );
  };

  const busy = requestChange.isPending || withdraw.isPending;

  return (
    <KeyboardScreen testID="vendor-payments">
      {view.dues === null ? null : (
        <View testID="payments-dues" className="gap-1 rounded-2xl bg-red-50 p-4">
          <Text className="text-base font-bold text-red-800">
            {t('vendorPayments.duesTitle', { amount: view.dues.amount_npr })}
          </Text>
          <Text className="text-sm text-red-800">
            {t('vendorPayments.duesBody', { date: formatPostedAt(view.dues.due_at, locale) })}
          </Text>
        </View>
      )}

      <Section title={t('vendorPayments.planTitle')}>
        <Text testID="payments-current-plan" className="text-base text-gray-900">
          {view.pricing_plan === null
            ? t('vendorPayments.noPlan')
            : `${view.pricing_plan.name} · ${planTerms(view.pricing_plan)}`}
        </Text>
        <Text className="text-sm text-gray-500">{t('vendorPayments.planHint')}</Text>
        {view.self_selectable_plans.map((plan) => {
          const selected = plan.id === selectedPlanId;
          return (
            <Pressable
              key={plan.id}
              testID={`payments-plan-${plan.id}`}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => {
                setPlanDraft(plan.id);
              }}
              className={`flex-row items-center gap-3 rounded-xl border-2 p-3 ${selected ? 'border-brand bg-brand-light' : 'border-gray-200 bg-white'}`}
            >
              <Ionicons
                name={selected ? 'radio-button-on' : 'radio-button-off'}
                size={22}
                color={selected ? colors.brand : colors.inactive}
              />
              <View className="flex-1">
                <Text className="text-base font-semibold text-gray-900">{plan.name}</Text>
                <Text className="text-sm text-gray-500">{planTerms(plan)}</Text>
              </View>
            </Pressable>
          );
        })}
        {pendingPlan === null ? null : (
          <View className="flex-row items-center gap-3">
            <Text testID="payments-plan-pending" className="flex-1 text-sm text-gray-700">
              {t('vendorPayments.pendingPlan', {
                date: formatPostedAt(pendingPlan.effective_from, locale),
              })}
            </Text>
            <Button
              testID="payments-plan-withdraw"
              label={t('vendorPayments.withdraw')}
              variant="secondary"
              size="sm"
              disabled={busy}
              onPress={() => {
                withdrawChange(pendingPlan.id);
              }}
            />
          </View>
        )}
        {view.self_selectable_plans.length === 0 ? null : (
          <Button
            testID="payments-plan-save"
            label={t('vendorPayments.switchPlan')}
            disabled={
              busy || selectedPlanId === null || selectedPlanId === (queuedPlanId ?? activePlanId)
            }
            onPress={sendPlan}
          />
        )}
      </Section>

      <Section title={t('vendorPayments.methodsTitle')}>
        <SwitchRow
          testID="payments-cod"
          label={t('vendorPayments.cod')}
          hint={t('vendorPayments.codHint')}
          value={choice.cod}
          onToggle={() => {
            setChoiceDraft(toggle(choice, 'cod'));
          }}
        />
        <SwitchRow
          testID="payments-prepayment"
          label={t('vendorPayments.prepayment')}
          hint={t('vendorPayments.prepaymentHint')}
          value={choice.prepayment}
          onToggle={() => {
            setChoiceDraft(toggle(choice, 'prepayment'));
          }}
        />
        <Text className="text-sm text-gray-500">
          {nextCycle === null
            ? t('vendorPayments.methodsHintNoCycle')
            : t('vendorPayments.methodsHint', { date: nextCycle })}
        </Text>
        {pendingMethods === null ? null : (
          <View className="flex-row items-center gap-3">
            <Text testID="payments-methods-pending" className="flex-1 text-sm text-gray-700">
              {t('vendorPayments.pendingMethods', {
                date: formatPostedAt(pendingMethods.effective_from, locale),
              })}
            </Text>
            <Button
              testID="payments-methods-withdraw"
              label={t('vendorPayments.withdraw')}
              variant="secondary"
              size="sm"
              disabled={busy}
              onPress={() => {
                withdrawChange(pendingMethods.id);
              }}
            />
          </View>
        )}
        <Button
          testID="payments-methods-save"
          label={t('vendorPayments.saveMethods')}
          disabled={busy || sameChoice(choice, upcoming)}
          onPress={sendMethods}
        />
      </Section>

      <Section title={t('vendorPayments.directTitle')}>
        {direct ? (
          <>
            <Text className="text-sm text-gray-500">
              {t('vendorPayments.directHint', { amount: view.prepaid_reserve_npr })}
            </Text>
            {gatewayPaymentMethods.map((gateway) => {
              const account = accountFor(gateways.data?.accounts ?? [], gateway);
              const state = merchantAccountState(account);
              const draft = merchant[gateway];
              const edit = (patch: Partial<typeof draft>): void => {
                setMerchant((current) => ({
                  ...current,
                  [gateway]: { ...current[gateway], ...patch },
                }));
              };
              return (
                <View key={gateway} className="gap-2 rounded-xl border border-gray-200 p-3">
                  <Text className="text-base font-semibold text-gray-900">
                    {t(`payment.${gateway}`)}
                  </Text>
                  <Text testID={`payments-merchant-${gateway}-state`} className="text-sm">
                    {account === undefined
                      ? t('vendorPayments.merchantState.MISSING')
                      : t(`vendorPayments.merchantState.${state}`, {
                          code: account.merchant_code,
                          hint: account.secret_hint,
                        })}
                  </Text>
                  <Input
                    testID={`payments-merchant-${gateway}-code`}
                    label={t('vendorPayments.merchantCode')}
                    value={draft.code}
                    onChangeText={(code) => {
                      edit({ code });
                    }}
                  />
                  <Input
                    testID={`payments-merchant-${gateway}-secret`}
                    label={t('vendorPayments.merchantSecret')}
                    value={draft.secret}
                    secure
                    onChangeText={(secret) => {
                      edit({ secret });
                    }}
                  />
                  <Button
                    testID={`payments-merchant-${gateway}-save`}
                    label={t('vendorPayments.saveMerchant')}
                    disabled={saveGateway.isPending || draft.code === '' || draft.secret === ''}
                    onPress={() => {
                      sendMerchant(gateway);
                    }}
                  />
                </View>
              );
            })}
          </>
        ) : (
          <Text testID="payments-direct-unavailable" className="text-sm text-gray-500">
            {t('vendorPayments.directUnavailable')}
          </Text>
        )}
      </Section>

      <Section title={t('vendorPayments.bankTitle')}>
        <Text className="text-sm text-gray-500">{t('vendorPayments.bankHint')}</Text>
        {(banks.data?.bank_accounts ?? []).map((account) => (
          <View
            key={account.id}
            testID={`payments-bank-${account.id}`}
            className="rounded-xl border border-gray-200 p-3"
          >
            <Text className="text-base font-semibold text-gray-900">
              {account.bank_name} · {account.branch_name}
            </Text>
            <Text className="text-sm text-gray-700">
              {account.account_name} · ****{account.account_number.slice(-4)}
            </Text>
            {account.is_primary ? (
              <Text className="text-sm font-semibold text-green-700">
                {t('vendorPayments.primary')}
              </Text>
            ) : null}
          </View>
        ))}
        <Input
          testID="payments-bank-name"
          label={t('vendorPayments.bankName')}
          value={bank.bank_name}
          onChangeText={(bank_name) => {
            setBank((current) => ({ ...current, bank_name }));
          }}
        />
        <Input
          testID="payments-bank-branch"
          label={t('vendorPayments.branchName')}
          value={bank.branch_name}
          onChangeText={(branch_name) => {
            setBank((current) => ({ ...current, branch_name }));
          }}
        />
        <Input
          testID="payments-bank-holder"
          label={t('vendorPayments.accountName')}
          value={bank.account_name}
          onChangeText={(account_name) => {
            setBank((current) => ({ ...current, account_name }));
          }}
        />
        <Input
          testID="payments-bank-number"
          label={t('vendorPayments.accountNumber')}
          value={bank.account_number}
          onChangeText={(account_number) => {
            setBank((current) => ({ ...current, account_number: account_number.trim() }));
          }}
        />
        <Input
          testID="payments-bank-routing"
          label={t('vendorPayments.routingCode')}
          value={bank.routing_or_swift_code ?? ''}
          onChangeText={(routing) => {
            setBank((current) => ({ ...current, routing_or_swift_code: routing }));
          }}
        />
        <Button
          testID="payments-bank-save"
          label={t('vendorPayments.addBank')}
          disabled={
            addBank.isPending ||
            bank.bank_name === '' ||
            bank.branch_name === '' ||
            bank.account_name === '' ||
            bank.account_number === ''
          }
          onPress={sendBank}
        />
      </Section>
    </KeyboardScreen>
  );
}
