import { IRD_ATTEMPT_TIMEOUT_MS, IRD_CAPTCHA_TIMEOUT_MS } from '@hamro-pasal/shared-types';
import { z } from 'zod';

import { IrdTransientError } from './ird-lookup';

/*
 * 2Captcha (https://2captcha.com/api-docs), its JSON API v2. The IRD's PAN search is guarded by an
 * invisible reCAPTCHA v2, so the task is `RecaptchaV2TaskProxyless` with the page's site key and
 * URL; the answer is the token the page would have got from grecaptcha.execute(). Decided by the
 * user 2026-10-21, with the terms-of-service risk of solving a government site's CAPTCHA accepted.
 */

export const TWO_CAPTCHA_API = 'https://api.2captcha.com';

/** 2Captcha's own advice: the first result is not ready for 15–20 s, then poll every 5 s. */
const FIRST_POLL_MS = 15_000;
const POLL_EVERY_MS = 5_000;

const createTaskAnswer = z.union([
  z.object({ errorId: z.literal(0), taskId: z.number().int() }),
  z.object({ errorId: z.number().int().positive(), errorCode: z.string().optional() }),
]);

const taskResultAnswer = z.union([
  z.object({ errorId: z.literal(0), status: z.literal('processing') }),
  z.object({
    errorId: z.literal(0),
    status: z.literal('ready'),
    solution: z.object({ gRecaptchaResponse: z.string().min(1) }),
  }),
  z.object({ errorId: z.number().int().positive(), errorCode: z.string().optional() }),
]);

export interface RecaptchaV2Task {
  readonly websiteURL: string;
  readonly websiteKey: string;
  readonly invisible: boolean;
}

export interface CaptchaSolver {
  /** The g-recaptcha-response token. Throws IrdTransientError when it cannot be had in time. */
  solveRecaptchaV2(task: RecaptchaV2Task): Promise<string>;
}

export interface TwoCaptchaOptions {
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly baseUrl?: string;
  /** Overall budget for one solve (default IRD_CAPTCHA_TIMEOUT_MS). */
  readonly budgetMs?: number;
}

export class TwoCaptchaSolver implements CaptchaSolver {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly baseUrl: string;
  private readonly budgetMs: number;

  constructor(private readonly options: TwoCaptchaOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.baseUrl = options.baseUrl ?? TWO_CAPTCHA_API;
    this.budgetMs = options.budgetMs ?? IRD_CAPTCHA_TIMEOUT_MS;
  }

  async solveRecaptchaV2(task: RecaptchaV2Task): Promise<string> {
    const deadline = this.now() + this.budgetMs;
    const created = createTaskAnswer.parse(
      await this.post('/createTask', {
        clientKey: this.options.apiKey,
        task: {
          type: 'RecaptchaV2TaskProxyless',
          websiteURL: task.websiteURL,
          websiteKey: task.websiteKey,
          isInvisible: task.invisible,
        },
      }),
    );
    if (!('taskId' in created)) {
      throw new IrdTransientError(`2Captcha refused the task: ${created.errorCode ?? 'unknown'}`);
    }

    let wait = FIRST_POLL_MS;
    for (;;) {
      if (this.now() + wait > deadline) {
        throw new IrdTransientError(
          `2Captcha did not solve the CAPTCHA within ${String(this.budgetMs / 1000)} s`,
        );
      }
      await this.sleep(wait);
      wait = POLL_EVERY_MS;
      const result = taskResultAnswer.parse(
        await this.post('/getTaskResult', {
          clientKey: this.options.apiKey,
          taskId: created.taskId,
        }),
      );
      if ('solution' in result) return result.solution.gRecaptchaResponse;
      if ('errorCode' in result || result.errorId !== 0) {
        const code = 'errorCode' in result ? result.errorCode : undefined;
        throw new IrdTransientError(`2Captcha could not solve it: ${code ?? 'unknown'}`);
      }
    }
  }

  /** One API call, abandoned after IRD_ATTEMPT_TIMEOUT_MS. The key never appears in an error. */
  private async post(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(IRD_ATTEMPT_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      throw new IrdTransientError(`2Captcha unreachable (${path})`, { cause: error });
    }
    if (!response.ok) {
      throw new IrdTransientError(`2Captcha answered HTTP ${String(response.status)} (${path})`);
    }
    try {
      return await response.json();
    } catch (error: unknown) {
      throw new IrdTransientError(`2Captcha answered something that is not JSON (${path})`, {
        cause: error,
      });
    }
  }
}
