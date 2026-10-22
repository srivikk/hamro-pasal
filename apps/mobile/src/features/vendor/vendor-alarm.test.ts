import { renderHook } from '@testing-library/react-native';

import { createAudioPlayer, mockAudio, onlyPlayer, resetMockAudio } from '../../test/fake-audio';
import { createVendorAlarm, useVendorAlarm } from './vendor-alarm';

// Metro bundles the sound as an asset id; a named stand-in proves which file the player loads.
jest.mock('../../../assets/sounds/vendor_alarm.wav', () => 'assets/sounds/vendor_alarm.wav');

beforeEach(() => {
  resetMockAudio();
});

describe('createVendorAlarm (expo-audio)', () => {
  it('asks for an audio session that plays in silent mode and pauses other apps', () => {
    createVendorAlarm();

    expect(mockAudio.modes).toEqual([{ playsInSilentMode: true, interruptionMode: 'doNotMix' }]);
  });

  it('loads nothing until the first order rings', () => {
    createVendorAlarm();

    expect(createAudioPlayer).not.toHaveBeenCalled();
  });

  it('starts the bundled alarm sound, looping, at full volume', () => {
    const alarm = createVendorAlarm();

    alarm.start();

    const player = onlyPlayer();
    expect(player.source).toBe('assets/sounds/vendor_alarm.wav');
    expect(player.loop).toBe(true);
    expect(player.volume).toBe(1);
    expect(player.play).toHaveBeenCalledTimes(1);
  });

  it('keeps looping (no second play) while it is already ringing', () => {
    const alarm = createVendorAlarm();

    alarm.start();
    alarm.start();

    expect(onlyPlayer().play).toHaveBeenCalledTimes(1);
  });

  it('stops by pausing and rewinding, so the next order starts from the first beep', () => {
    const alarm = createVendorAlarm();
    alarm.start();

    alarm.stop();

    const player = onlyPlayer();
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(player.seekTo).toHaveBeenCalledWith(0);
    expect(player.playing).toBe(false);
  });

  it('rings again on the next order with the same player', () => {
    const alarm = createVendorAlarm();
    alarm.start();
    alarm.stop();

    alarm.start();

    const player = onlyPlayer();
    expect(player.play).toHaveBeenCalledTimes(2);
    expect(player.playing).toBe(true);
  });

  it('ignores stop while silent (no pause of a player that is not playing)', () => {
    const alarm = createVendorAlarm();

    alarm.stop();
    alarm.start();
    alarm.stop();
    alarm.stop();

    expect(onlyPlayer().pause).toHaveBeenCalledTimes(1);
  });

  it('frees the native player on release and cannot ring afterwards', () => {
    const alarm = createVendorAlarm();
    alarm.start();

    alarm.release();
    alarm.start();

    const player = onlyPlayer();
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(player.remove).toHaveBeenCalledTimes(1);
    expect(player.play).toHaveBeenCalledTimes(1);
  });
});

describe('useVendorAlarm', () => {
  it('rings while ringing is true and stops as soon as it turns false', () => {
    const { rerender } = renderHook(
      ({ ringing }: { ringing: boolean }) => {
        useVendorAlarm(ringing);
      },
      { initialProps: { ringing: false } },
    );
    expect(mockAudio.players).toEqual([]);

    rerender({ ringing: true });
    const player = onlyPlayer();
    expect(player.play).toHaveBeenCalledTimes(1);

    rerender({ ringing: true }); // another render while ringing: still one play
    expect(player.play).toHaveBeenCalledTimes(1);

    rerender({ ringing: false });
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(player.playing).toBe(false);
  });

  it('rings at once when mounted with an order already waiting', () => {
    renderHook(() => {
      useVendorAlarm(true);
    });

    expect(onlyPlayer().play).toHaveBeenCalledTimes(1);
  });

  it('silences and frees the player when the screen unmounts mid-alarm', () => {
    const { unmount } = renderHook(() => {
      useVendorAlarm(true);
    });

    unmount();

    const player = onlyPlayer();
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(player.remove).toHaveBeenCalledTimes(1);
    expect(player.playing).toBe(false);
  });
});
