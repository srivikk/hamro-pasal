import { isNepalPhone, normalizeNepalPhone } from '@hamro-pasal/shared-types';

/*
 * IVR voice calls (infrastructure §6: "Twilio Voice API (or local Nepal SIP trunk) triggered via
 * BullMQ workers to fire automated voice calls when vendors miss the 90-second alert threshold").
 * Only the MOCK adapter exists so far. Every adapter goes through prepareOutboundCall, so no code
 * path can dial a non-Nepal or malformed number (SPEC Nepal §4: +977 only).
 */

export interface IvrCall {
  /** Any common Nepal format ("98XXXXXXXX", "+977-98..."); normalised before dialling. */
  readonly to: string;
  /** What the text-to-speech voice reads to the vendor. */
  readonly script: string;
}

export interface OutboundIvrCall {
  /** Always matches NEPAL_PHONE_REGEX: +9779XXXXXXXXX. */
  readonly to: string;
  readonly script: string;
}

export type IvrProviderName = 'MOCK';

export interface IvrCallPlaced {
  readonly provider: IvrProviderName;
  readonly to: string;
}

export interface IvrGateway {
  readonly provider: IvrProviderName;
  /** Resolves once the provider accepted the call; rejects with IvrCallError if it refused. */
  call(call: IvrCall): Promise<IvrCallPlaced>;
}

export class IvrCallError extends Error {
  constructor(
    readonly provider: IvrProviderName,
    reason: string,
  ) {
    super(`${provider} IVR call failed: ${reason}`);
    this.name = 'IvrCallError';
  }
}

/** Longest script we read out (about 30 s of speech). */
export const MAX_IVR_SCRIPT_LENGTH = 500;

/** The single choke point for outbound calls: strict +977 number and a bounded, non-empty script. */
export function prepareOutboundCall(call: IvrCall): OutboundIvrCall {
  const to = normalizeNepalPhone(call.to);
  if (!isNepalPhone(to)) {
    throw new Error('Recipient failed +977 validation');
  }
  const script = call.script.trim();
  if (script.length === 0 || script.length > MAX_IVR_SCRIPT_LENGTH) {
    throw new RangeError(`IVR script must be 1-${String(MAX_IVR_SCRIPT_LENGTH)} characters`);
  }
  return { to, script };
}

/** Places no call: records it and hands it to `onCall` (development and tests). */
export class MockIvrGateway implements IvrGateway {
  readonly provider = 'MOCK';
  readonly placed: OutboundIvrCall[] = [];

  constructor(private readonly onCall?: (call: OutboundIvrCall) => void) {}

  // async, so validation failures surface as rejections like a real adapter's would.
  // eslint-disable-next-line @typescript-eslint/require-await
  async call(call: IvrCall): Promise<IvrCallPlaced> {
    const outbound = prepareOutboundCall(call);
    this.placed.push(outbound);
    this.onCall?.(outbound);
    return { provider: this.provider, to: outbound.to };
  }
}
