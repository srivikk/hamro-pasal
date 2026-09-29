import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useLocalSearchParams } from 'expo-router';
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

import { Button } from '../../../src/components/Button';
import type { ChatAttachment } from '../../../src/features/dispute/chat-contract';
import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_MESSAGE_LENGTH,
} from '../../../src/features/dispute/chat-contract';
import { postDeliveryDeadline } from '../../../src/features/dispute/dispute-window';
import { uploadDisputeEvidence } from '../../../src/features/dispute/mock-evidence-upload';
import { useDisputeChat, type ThreadMessage } from '../../../src/features/dispute/useDisputeChat';
import { useBeforeDeadline } from '../../../src/lib/useBeforeDeadline';
import { useOrderStore } from '../../../src/store/useOrderStore';

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
      <Text className="mb-1 text-xs font-semibold text-neutral-500">{name}</Text>
      <View className={`gap-2 rounded-2xl px-4 py-3 ${mine ? 'bg-brand' : 'bg-white'}`}>
        {message.body === '' ? null : (
          <Text className={mine ? 'text-white' : 'text-neutral-900'}>{message.body}</Text>
        )}
        {message.attachments.map((attachment) => (
          <Image
            key={attachment.url}
            source={{ uri: attachment.url }}
            accessibilityIgnoresInvertColors
            className="h-40 w-56 rounded-xl bg-neutral-200"
          />
        ))}
      </View>
      {status === 'sending' ? (
        <Text className="mt-1 text-xs text-neutral-500">{t('dispute.status.sending')}</Text>
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

function DisputeChat({ orderId }: { orderId: string }) {
  const { t } = useTranslation();
  const { thread, connection, send, retry } = useDisputeChat(orderId);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [attachFailed, setAttachFailed] = useState(false);

  const attach = async (): Promise<void> => {
    setAttachFailed(false);
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
      });
      setAttachments((current) => [...current, uploaded]);
    } catch {
      setAttachFailed(true);
    } finally {
      setAttaching(false);
    }
  };

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-neutral-50"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {connection === 'connected' ? null : (
        <Text className="bg-amber-50 px-4 py-2 text-xs text-amber-900" testID="chat-connection">
          {t(`dispute.connection.${connection}`)}
        </Text>
      )}
      <Text className="px-4 pt-3 text-xs text-neutral-500">{t('dispute.privacy')}</Text>
      <FlatList
        data={thread}
        keyExtractor={(entry) => entry.message.client_id ?? entry.message.id}
        contentContainerStyle={{ paddingVertical: 12, flexGrow: 1 }}
        ListEmptyComponent={
          <Text className="px-6 py-8 text-center text-sm text-neutral-600">
            {t('dispute.empty')}
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
                className="h-14 w-14 rounded-lg bg-neutral-200"
              />
            </Pressable>
          ))}
        </View>
      )}
      {attachFailed ? (
        <Text className="px-4 pb-2 text-xs text-red-700">{t('dispute.attachFailed')}</Text>
      ) : null}
      <View className="flex-row items-end gap-2 border-t border-neutral-200 bg-white p-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('dispute.attach')}
          testID="chat-attach"
          disabled={attaching || attachments.length >= MAX_CHAT_ATTACHMENTS}
          onPress={() => void attach()}
          className="h-11 w-11 items-center justify-center rounded-full bg-neutral-100"
        >
          <Ionicons
            name={attaching ? 'hourglass-outline' : 'image-outline'}
            size={22}
            color="#404040"
          />
        </Pressable>
        <TextInput
          testID="chat-input"
          accessibilityLabel={t('dispute.placeholder')}
          placeholder={t('dispute.placeholder')}
          value={draft}
          onChangeText={setDraft}
          maxLength={MAX_CHAT_MESSAGE_LENGTH}
          multiline
          className="max-h-28 flex-1 rounded-2xl border border-neutral-300 px-3 py-2 text-neutral-900"
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

/** SPEC customer flow step 11: dispute chat, open for 48 h after delivery. */
export default function DisputeScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const order = useOrderStore((state) => state.orders[id]);
  const windowOpen = useBeforeDeadline(postDeliveryDeadline(order?.deliveredAt ?? null));
  const eligible = order?.state === 'DELIVERED' && windowOpen;

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: t('dispute.title'),
          headerBackTitle: t('common.back'),
        }}
      />
      {eligible ? (
        <DisputeChat orderId={id} />
      ) : (
        <View className="flex-1 items-center justify-center bg-neutral-50 px-8">
          <Text className="text-center text-base text-neutral-700" testID="dispute-closed">
            {t('dispute.closed')}
          </Text>
        </View>
      )}
    </>
  );
}
