import { IRD_ATTEMPT_TIMEOUT_MS } from '@hamro-pasal/shared-types';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

import { IrdTransientError, type IrdLookupResult, type IrdPanLookup } from './ird-lookup';
import { parseIrdResult } from './ird-result-parser';
import { describeProxy, type ProxyRotation } from './proxy-rotation';
import type { CaptchaSolver } from './two-captcha';

/*
 * The IRD's public PAN search in a headless Chromium (decided by the user 2026-10-21). The page is
 * https://ird.gov.np/pan-search/: a form with one field (#pan) guarded by an invisible reCAPTCHA
 * v2; on submit the page calls grecaptcha.execute(), whose callback `onSubmit(token)` POSTs the form
 * to /api/getPanSearch/ and renders the answer into #result (or a message into #errdiv).
 *
 * One attempt:
 * 1. a new browser context, through the next proxy of IRD_PROXY_URLS when there is one;
 * 2. load the page; read the reCAPTCHA site key from `.g-recaptcha[data-sitekey]`. A page without
 *    the field, the site key or the `onSubmit` callback is LAYOUT_CHANGED;
 * 3. have 2Captcha solve the reCAPTCHA for that key and URL;
 * 4. type the PAN, call the page's own `onSubmit(token)` (what the reCAPTCHA would have called),
 *    wait for /api/getPanSearch/ and then for the result or a message to appear;
 * 5. read #result and #errdiv, and parse them (ird-result-parser.ts).
 *
 * Each network step is abandoned after IRD_ATTEMPT_TIMEOUT_MS (30 s); the CAPTCHA solver has its
 * own budget. The context is always closed, also on failure. The browser itself is launched on the
 * first lookup and kept for the next ones.
 *
 * Browser binary: playwright-core ships none. Install Chromium in the worker image with
 * `npx playwright-core install --with-deps chromium`, or point IRD_CHROMIUM_PATH at one.
 */

export interface PlaywrightIrdLookupOptions {
  readonly searchUrl: string;
  readonly solver: CaptchaSolver;
  readonly proxies: ProxyRotation;
  /** An installed Chromium; default: the one playwright-core installed. */
  readonly executablePath?: string;
  /** Tests: a browser to use instead of launching one. */
  readonly launch?: () => Promise<Browser>;
}

const SEARCH_ENDPOINT = '/api/getPanSearch/';

export class PlaywrightIrdLookup implements IrdPanLookup {
  private browser: Promise<Browser> | null = null;

  constructor(private readonly options: PlaywrightIrdLookupOptions) {}

  private browserInstance(): Promise<Browser> {
    this.browser ??= (
      this.options.launch ??
      (() =>
        chromium.launch({
          headless: true,
          ...(this.options.executablePath === undefined
            ? {}
            : { executablePath: this.options.executablePath }),
        }))
    )().catch((error: unknown) => {
      // Launching again on the next attempt is better than keeping a rejected browser forever.
      this.browser = null;
      throw new IrdTransientError('the headless browser could not start', { cause: error });
    });
    return this.browser;
  }

  async lookup(pan: string): Promise<IrdLookupResult> {
    const browser = await this.browserInstance();
    const proxy = this.options.proxies.next();
    let context: BrowserContext | undefined;
    try {
      context = await browser.newContext({
        ...(proxy === undefined ? {} : { proxy }),
        locale: 'en-US',
        timezoneId: 'Asia/Kathmandu',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(IRD_ATTEMPT_TIMEOUT_MS);
      return await this.search(page, pan);
    } catch (error: unknown) {
      if (error instanceof IrdTransientError) throw error;
      // Playwright's own errors (timeouts, a refused connection, a proxy that is down).
      throw new IrdTransientError(
        `the IRD search failed via ${describeProxy(proxy)}: ${
          error instanceof Error ? (error.message.split('\n')[0] ?? error.name) : String(error)
        }`,
        { cause: error },
      );
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  private async search(page: Page, pan: string): Promise<IrdLookupResult> {
    const response = await page.goto(this.options.searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: IRD_ATTEMPT_TIMEOUT_MS,
    });
    if (response === null || response.status() >= 500 || response.status() === 429) {
      throw new IrdTransientError(
        `the IRD page answered HTTP ${response === null ? 'nothing' : String(response.status())}`,
      );
    }
    if (!response.ok()) {
      return {
        kind: 'LAYOUT_CHANGED',
        detail: `the IRD page answered HTTP ${String(response.status())}`,
      };
    }

    const siteKey = await page
      .locator('.g-recaptcha[data-sitekey]')
      .first()
      .getAttribute('data-sitekey', { timeout: 5_000 })
      .catch(() => null);
    const hasField = (await page.locator('#form #pan').count()) === 1;
    const hasCallback = (await page.evaluate("typeof onSubmit === 'function'")) === true;
    if (siteKey === null || siteKey === '' || !hasField || !hasCallback) {
      return {
        kind: 'LAYOUT_CHANGED',
        detail: `the search form is not as expected (site key: ${siteKey === null ? 'missing' : 'present'}, PAN field: ${hasField ? 'present' : 'missing'}, onSubmit: ${hasCallback ? 'present' : 'missing'})`,
      };
    }

    const token = await this.options.solver.solveRecaptchaV2({
      websiteURL: page.url(),
      websiteKey: siteKey,
      invisible: true,
    });

    await page.fill('#pan', pan);
    const searched = page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === SEARCH_ENDPOINT,
      { timeout: IRD_ATTEMPT_TIMEOUT_MS },
    );
    // What the invisible reCAPTCHA would call with its token: the page's own submit.
    await page.evaluate(`onSubmit(${JSON.stringify(token)})`);
    const answer = await searched;
    if (answer.status() >= 500 || answer.status() === 429) {
      throw new IrdTransientError(`the IRD search answered HTTP ${String(answer.status())}`);
    }
    await page.waitForFunction(
      "document.querySelector('#result table') !== null || (document.querySelector('#errdiv')?.textContent ?? '').trim() !== ''",
      undefined,
      { timeout: IRD_ATTEMPT_TIMEOUT_MS },
    );
    return parseIrdResult({
      resultHtml: await page.locator('#result').innerHTML(),
      errorText: (await page.locator('#errdiv').textContent()) ?? '',
    });
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    if (browser !== null) await (await browser.catch(() => null))?.close();
  }
}
