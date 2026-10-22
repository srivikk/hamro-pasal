import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { useEffect, useRef } from 'react';

import alarmSound from '../../../assets/sounds/vendor_alarm.wav';

/** Full volume: the alarm has to be heard across a busy shop (SPEC: "high-priority audio alarm"). */
export const VENDOR_ALARM_VOLUME = 1;

/**
 * The incoming-order alarm (vendor flow step 6). Built on `expo-audio`, the SDK 57 audio module
 * (`expo-av` was removed from the Expo SDK after SDK 54).
 */
export interface VendorAlarm {
  /** Starts looping the alarm. Calling it while it rings does nothing. */
  start(): void;
  /** Silences the alarm and rewinds it, so the next order starts from the first beep. */
  stop(): void;
  /** Stops and frees the native player. The alarm cannot be used afterwards. */
  release(): void;
}

/**
 * Plays in silent mode and takes exclusive audio focus (other apps' audio pauses) so a vendor with
 * the ringer off or music playing still hears a new order.
 */
async function configureAlarmAudio(): Promise<void> {
  await setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'doNotMix' });
}

export function createVendorAlarm(): VendorAlarm {
  let player: AudioPlayer | null = null;
  let ringing = false;
  let released = false;

  const loadedPlayer = (): AudioPlayer => {
    if (player === null) {
      player = createAudioPlayer(alarmSound);
      player.loop = true;
      player.volume = VENDOR_ALARM_VOLUME;
    }
    return player;
  };

  configureAlarmAudio().catch((error: unknown) => {
    console.warn('[vendor-alarm] could not configure the audio session', error);
  });

  const stop = (): void => {
    if (!ringing) return;
    ringing = false;
    if (player === null) return;
    player.pause();
    player.seekTo(0).catch(() => undefined); // rewinding is cosmetic
  };

  return {
    start: () => {
      if (ringing || released) return;
      ringing = true;
      loadedPlayer().play();
    },
    stop,
    release: () => {
      stop();
      released = true;
      player?.remove();
      player = null;
    },
  };
}

/**
 * Rings the alarm while `ringing` is true and silences it as soon as it turns false. The player is
 * created once per mount and freed on unmount, so leaving the dashboard always stops the sound.
 */
export function useVendorAlarm(
  ringing: boolean,
  create: () => VendorAlarm = createVendorAlarm,
): void {
  const alarm = useRef<VendorAlarm | null>(null);

  useEffect(() => {
    const created = create();
    alarm.current = created;
    return () => {
      alarm.current = null;
      created.release();
    };
  }, [create]);

  useEffect(() => {
    if (ringing) alarm.current?.start();
    else alarm.current?.stop();
  }, [ringing, create]);
}
