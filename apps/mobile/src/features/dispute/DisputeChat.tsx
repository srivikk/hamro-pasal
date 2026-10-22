import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import {
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../../api/http';
import {
  EvidenceRejectedError,
  uploadDisputeEvidence,
  type EvidenceRejection,
} from '../../api/uploads';
import { Button } from '../../components/Button';
import { useToastStore } from '../../store/useToastStore';
import type { ChatAttachment } from './chat-contract';
import { MAX_CHAT_ATTACHMENTS, MAX_CHAT_MESSAGE_LENGTH } from './chat-contract';
import { useEscalation, type ChatParty } from './useEscalation';
import { useDisputeChat, type ThreadMessage } from './useDisputeChat';

/*
 * Step 7.3 (SPEC core 6): an order's Customer <-> Shop conversation, its escalation to Hamro
 * Pasal, and (2026-10-21) the same screen for the shop in the Seller app. Moved out of
 * app/order/[id]/dispute.tsx so both apps render one implementation.
 */

/** Step 7.3: an escalation's reason, as the server checks it. */
const REASON_MIN = 10;
const REASON_MAX = 500;

/**
 * Step 7.3 (SPEC core 6): "Escalate to Hamro Pasal", once per order, with a reason. Escalated, the
 * Hamro Pasal team joins this conversation and decides; the shop is told.
 */
function EscalationBar({
  orderId,
  escalated,
  party,
}: {
  orderId: string;
  escalated: boolean;
  party: ChatParty;
}) {
  const { t } = useTranslation();
  const showToast = useToastStore((state) => state.show);
  const escalation = useEscalation(orderId, party);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [done, setDone] = useState(escalated);
  const trimmed = reason.trim();

  if (done) {
    return (
      <Text className="bg-blue-50 px-4 py-2 text-xs text-blue-900" testID="dispute-escalated">
        {t('dispute.escalated')}
      </Text>
    );
  }
  if (!open) {
    return (
      <Pressable
        accessibilityRole="button"
        testID="dispute-escalate"
        className="mx-4 mt-2 self-start rounded-lg border border-gray-300 bg-white px-3 py-1.5 active:opacity-70"
        onPress={() => {
          setOpen(true);
        }}
      >
        <Text className="text-xs font-semibold text-gray-800">{t('dispute.escalate')}</Text>
      </Pressable>
    );
  }
  return (
    <View className="mx-4 mt-2 rounded-xl bg-white p-3" testID="dispute-escalate-form">
      <Text className="mb-2 text-xs text-gray-600">{t('dispute.escalateHint')}</Text>
      <TextInput
        testID="dispute-escalate-reason"
        className="min-h-16 rounded-lg border border-gray-300 px-3 py-2 text-sm"
        multiline
        maxLength={REASON_MAX}
        value={reason}
        onChangeText={setReason}
        placeholder={t('dispute.escalatePlaceholder')}
      />
      <View className="mt-2 flex-row justify-end gap-2">
        <Button
          label={t('address.cancel')}
          size="sm"
          variant="secondary"
          onPress={() => {
            setOpen(false);
          }}
        />
        <Button
          label={t('dispute.escalateSubmit')}
          size="sm"
          disabled={trimmed.length < REASON_MIN || escalation.isPending}
          onPress={() => {
            escalation.mutate(trimmed, {
              onSuccess: () => {
                setDone(true);
                showToast(t('dispute.escalatedToast'), 'info');
              },
              onError: (error) => {
                if (error instanceof ApiError && error.code === 'ALREADY_ESCALATED') {
                  setDone(true);
                  return;
                }
                showToast(
                  t(
                    error instanceof ApiError && error.code === 'DISPUTE_WINDOW_CLOSED'
                      ? 'dispute.closed'
                      : 'dispute.escalateFailed',
                  ),
                  'error',
                );
              },
            });
          }}
        />
      </View>
    </View>
  );
}

function MessageBubble({ entry, onRetry }: { entry: ThreadMessage; onRetry: () => void }) {
  const { t } = useTranslation();
  const { message, mine, status } = entry;
  // Privacy (SPEC implicit requirement 6): the sender was reduced to id, first name and role by
  // the chat contract, so only a first name (or a role) can ever be shown here.
  const name = mine
    ? t('dispute.you')
    : (message.sender.first_name ?? t(`dispute.roles.${message.sender.role}`));

  return (
    <View
      className={`mx-4 mb-3 max-w-[80%] ${mine ? 'self-end items-end' : 'self-start items-start'}`}
      testID={`chat-message-${message.id}`}
    >
      <Text className="mb-1 text-xs font-semibold text-gray-500">{name}</Text>
      <View className={`gap-2 rounded-2xl px-4 py-3 ${mine ? 'bg-brand' : 'bg-white'}`}>
        {message.body === '' ? null : (
          <Text className={mine ? 'text-white' : 'text-gray-900'}>{message.body}</Text>
        )}
        {message.attachments.map((attachment) => (
          <Image
            key={attachment.url}
            source={{ uri: attachment.url }}
            accessibilityIgnoresInvertColors
            className="h-40 w-56 rounded-xl bg-gray-200"
          />
        ))}
      </View>
      {status === 'sending' ? (
        <Text className="mt-1 text-xs text-gray-500">{t('dispute.status.sending')}</Text>
      ) : null}
      {status === 'failed' ? (
        <Pressable accessibilityRole="button" onPress={onRetry}>
          <Text className="mt-1 text-xs font-semibold text-red-700">
            {t('dispute.status.failed')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const ATTACH_ERRORS = {
  too_large: 'dispute.attachTooLarge',
  not_an_image: 'dispute.attachNotImage',
  window_closed: 'dispute.closed',
  failed: 'dispute.attachFailed',
} as const;

export function ClosedNotice({ message }: { message: string }) {
  return (
    <View className="flex-1 items-center justify-center bg-gray-50 px-8">
      <Text className="text-center text-base text-gray-700" testID="dispute-closed">
        {message}
      </Text>
    </View>
  );
}

/**
 * The conversation of one order, for either party (2026-10-21: the Seller app opens it too).
 * Only the customer attaches evidence photos: the upload route is the customer's.
 */
export function DisputeChat({
  orderId,
  escalated,
  party = 'CUSTOMER',
}: {
  orderId: string;
  escalated: boolean;
  party?: ChatParty;
}) {
  const { t } = useTranslation();
  const { thread, connection, unavailable, send, retry, historyStatus, retryHistory } =
    useDisputeChat(orderId);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<EvidenceRejection | 'failed' | null>(null);

  const attach = async (): Promise<void> => {
    setAttachError(null);
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.75,
      allowsMultipleSelection: false,
    });
    const asset = picked.canceled ? undefined : picked.assets[0];
    if (asset === undefined) return;
    setAttaching(true);
    try {
      const uploaded = await uploadDisputeEvidence(orderId, {
        uri: asset.uri,
        mimeType: asset.mimeType ?? null,
        fileSize: asset.fileSize ?? null,
        fileName: asset.fileName ?? null,
      });
      setAttachments((current) => [...current, uploaded]);
    } catch (error) {
      setAttachError(error instanceof EvidenceRejectedError ? error.reason : 'failed');
    } finally {
      setAttaching(false);
    }
  };

  if (unavailable !== null) {
    // The server's decision (window closed, or not this user's order) overrides the device's.
    return (
      <ClosedNotice
        message={t(
          unavailable === 'DISPUTE_WINDOW_CLOSED' ? 'dispute.closed' : 'dispute.unavailable',
        )}
      />
    );
  }

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-gray-50"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {connection === 'connected' ? null : (
        <Text className="bg-amber-50 px-4 py-2 text-xs text-amber-900" testID="chat-connection">
          {t(`dispute.connection.${connection}`)}
        </Text>
      )}
      <EscalationBar orderId={orderId} escalated={escalated} party={party} />
      <Text className="px-4 pt-3 text-xs text-gray-500">{t('dispute.privacy')}</Text>
      {historyStatus === 'failed' ? (
        <View
          className="mx-4 mt-2 flex-row items-center justify-between gap-2 rounded-xl bg-red-50 px-3 py-2"
          testID="chat-history-failed"
        >
          <Text className="flex-1 text-xs text-red-800">{t('dispute.historyFailed')}</Text>
          <Pressable accessibilityRole="button" onPress={retryHistory} hitSlop={8}>
            <Text className="text-xs font-semibold text-red-800">{t('dispute.historyRetry')}</Text>
          </Pressable>
        </View>
      ) : null}
      <FlatList
        data={thread}
        // Own messages keep their device id, so the local copy and the server's share one cell.
        keyExtractor={(entry) =>
          entry.mine ? (entry.message.client_id ?? entry.message.id) : entry.message.id
        }
        contentContainerStyle={{ paddingVertical: 12, flexGrow: 1 }}
        ListEmptyComponent={
          <Text className="px-6 py-8 text-center text-sm text-gray-500" testID="chat-empty">
            {t(historyStatus === 'loading' ? 'dispute.historyLoading' : 'dispute.empty')}
          </Text>
        }
        renderItem={({ item }) => (
          <MessageBubble
            entry={item}
            onRetry={() => {
              if (item.message.client_id !== null) retry(item.message.client_id);
            }}
          />
        )}
      />
      {attachments.length === 0 ? null : (
        <View className="flex-row gap-2 px-4 pb-2">
          {attachments.map((attachment) => (
            <Pressable
              key={attachment.url}
              accessibilityRole="button"
              accessibilityLabel={t('dispute.removeAttachment')}
              onPress={() => {
                setAttachments((current) => current.filter((item) => item.url !== attachment.url));
              }}
            >
              <Image
                source={{ uri: attachment.url }}
                className="h-14 w-14 rounded-lg bg-gray-200"
              />
            </Pressable>
          ))}
        </View>
      )}
      {attachError === null ? null : (
        <Text className="px-4 pb-2 text-xs text-red-700" testID="chat-attach-error">
          {t(ATTACH_ERRORS[attachError])}
        </Text>
      )}
      <View className="flex-row items-end gap-2 border-t border-gray-200 bg-white p-3">
        {party === 'CUSTOMER' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('dispute.attach')}
            testID="chat-attach"
            disabled={attaching || attachments.length >= MAX_CHAT_ATTACHMENTS}
            onPress={() => void attach()}
            className="h-11 w-11 items-center justify-center rounded-full bg-gray-100"
          >
            <Ionicons
              name={attaching ? 'hourglass-outline' : 'image-outline'}
              size={22}
              color="#404040"
            />
          </Pressable>
        ) : null}
        <TextInput
          testID="chat-input"
          accessibilityLabel={t('dispute.placeholder')}
          placeholder={t('dispute.placeholder')}
          value={draft}
          onChangeText={setDraft}
          maxLength={MAX_CHAT_MESSAGE_LENGTH}
          multiline
          className="max-h-28 flex-1 rounded-2xl border border-gray-300 px-3 py-2 text-gray-900"
        />
        <Button
          label={t('dispute.send')}
          size="sm"
          disabled={draft.trim() === '' && attachments.length === 0}
          onPress={() => {
            if (send(draft, attachments)) {
              setDraft('');
              setAttachments([]);
            }
          }}
        />
      </View>
    </KeyboardAvoidingView>
  );
}
