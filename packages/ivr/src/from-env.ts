import type { ServerEnv } from '@hamro-pasal/shared-types';

import { MockIvrGateway, type IvrGateway, type OutboundIvrCall } from './ivr-gateway';

export type IvrEnv = Pick<ServerEnv, 'IVR_PROVIDER'>;

export interface IvrGatewayFromEnvOptions {
  /** Where IVR_PROVIDER=MOCK prints each call (default: console.info). */
  readonly mockLog?: (line: string) => void;
}

/** The line IVR_PROVIDER=MOCK prints instead of calling: `[ivr:mock] Calling +977…: "<script>"`. */
export function mockIvrLogLine(call: OutboundIvrCall): string {
  return `[ivr:mock] Calling ${call.to}: "${call.script}"`;
}

/**
 * The IVR adapter for IVR_PROVIDER, or null when calls are DISABLED (the escalation is then
 * SMS only). MOCK makes no network call and logs the call instead (parseServerEnv refuses it in
 * production).
 */
export function ivrGatewayFromEnv(
  env: IvrEnv,
  options: IvrGatewayFromEnvOptions = {},
): IvrGateway | null {
  switch (env.IVR_PROVIDER) {
    case 'MOCK': {
      const log =
        options.mockLog ??
        ((line: string) => {
          console.info(line);
        });
      return new MockIvrGateway((call) => {
        log(mockIvrLogLine(call));
      });
    }
    case 'DISABLED':
      return null;
  }
}
