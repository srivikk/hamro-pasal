import { ivrGatewayFromEnv, mockIvrLogLine } from './from-env';
import { MAX_IVR_SCRIPT_LENGTH, MockIvrGateway, prepareOutboundCall } from './ivr-gateway';

const SCRIPT = 'You have a pending order on Hamro Pasal.';

describe('prepareOutboundCall', () => {
  it('normalises any Nepal mobile format to +977', () => {
    expect(prepareOutboundCall({ to: '9812345678', script: SCRIPT }).to).toBe('+9779812345678');
    expect(prepareOutboundCall({ to: '+977-9812345678', script: ` ${SCRIPT} ` })).toEqual({
      to: '+9779812345678',
      script: SCRIPT,
    });
  });

  it('refuses a non-Nepal number', () => {
    expect(() => prepareOutboundCall({ to: '+14155550100', script: SCRIPT })).toThrow('+977');
  });

  it('refuses an empty or over-long script', () => {
    expect(() => prepareOutboundCall({ to: '9812345678', script: '  ' })).toThrow(RangeError);
    expect(() =>
      prepareOutboundCall({ to: '9812345678', script: 'a'.repeat(MAX_IVR_SCRIPT_LENGTH + 1) }),
    ).toThrow(RangeError);
  });
});

describe('ivrGatewayFromEnv', () => {
  it('MOCK logs the call and records it', async () => {
    const lines: string[] = [];
    const gateway = ivrGatewayFromEnv(
      { IVR_PROVIDER: 'MOCK' },
      { mockLog: (line) => lines.push(line) },
    );

    expect(gateway).toBeInstanceOf(MockIvrGateway);
    const placed = await gateway?.call({ to: '9812345678', script: SCRIPT });

    expect(placed).toEqual({ provider: 'MOCK', to: '+9779812345678' });
    expect(lines).toEqual([
      '[ivr:mock] Calling +9779812345678: "You have a pending order on Hamro Pasal."',
    ]);
    expect((gateway as MockIvrGateway).placed).toEqual([{ to: '+9779812345678', script: SCRIPT }]);
  });

  it('MOCK prints to console.info by default', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await ivrGatewayFromEnv({ IVR_PROVIDER: 'MOCK' })?.call({ to: '9812345678', script: SCRIPT });
      expect(info).toHaveBeenCalledWith(mockIvrLogLine({ to: '+9779812345678', script: SCRIPT }));
    } finally {
      info.mockRestore();
    }
  });

  it('MOCK rejects (does not log) a call to a non-Nepal number', async () => {
    const lines: string[] = [];
    const gateway = ivrGatewayFromEnv(
      { IVR_PROVIDER: 'MOCK' },
      { mockLog: (line) => lines.push(line) },
    );

    await expect(gateway?.call({ to: '+14155550100', script: SCRIPT })).rejects.toThrow('+977');
    expect(lines).toEqual([]);
  });

  it('DISABLED places no calls at all', () => {
    expect(ivrGatewayFromEnv({ IVR_PROVIDER: 'DISABLED' })).toBeNull();
  });
});
