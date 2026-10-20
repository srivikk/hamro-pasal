import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { chromium, type Browser } from 'playwright-core';

import { IrdTransientError } from '../src/kyc/ird-lookup';
import { PlaywrightIrdLookup } from '../src/kyc/playwright-ird-lookup';
import { ProxyRotation } from '../src/kyc/proxy-rotation';
import type { CaptchaSolver } from '../src/kyc/two-captcha';

/**
 * The headless-browser adapter in a real Chromium (2026-10-21), against a local replica of the
 * IRD PAN search (https://ird.gov.np/pan-search/ as read on 2026-10-21): the same form (#form,
 * #pan), the reCAPTCHA's `.g-recaptcha[data-sitekey]`, the page's `onSubmit(token)` that POSTs to
 * /api/getPanSearch/ and renders the answer into #result or a message into #errdiv. Google's
 * reCAPTCHA script is not loaded; the replica refuses any token but the one the solver gives.
 *
 * Needs Chromium (`npx playwright-core install chromium`); without it the suite fails, unless
 * SKIP_BROWSER_TESTS=true says to skip it.
 */

const SITE_KEY = '6LdZWZ8pAAAAAAfBIJLQaO6RNoYDSVDNfc-avUhy';
const GOOD_TOKEN = 'solved-token';

const PAGE = (withSiteKey: boolean) => `<!doctype html>
<html><head><meta charset="utf-8"><title>PAN Search</title></head><body>
<form class="form-horizontal" id="form" method="post" onsubmit="taxSearch(event)">
  <input type="hidden" name="csrfmiddlewaretoken" value="csrf-123">
  <input class="form-control" id="pan" name="pan" type="text" required />
  ${withSiteKey ? `<div class="g-recaptcha" data-sitekey="${SITE_KEY}" data-size="invisible" data-callback="onSubmit"></div>` : ''}
  <div class="col-sm-9" id="errdiv"></div>
  <button id="submit" type="submit">खोज्नुहोस्</button>
</form>
<div id="loader" style="display:none;"></div>
<div id="result" class="mt-4"></div>
<script>
function safe(v) { return v === null || v === undefined || v === "" ? "-" : v; }
function onSubmit(token) {
  document.getElementById("result").innerHTML = "";
  document.getElementById("errdiv").innerHTML = "";
  const formData = new FormData(document.getElementById("form"));
  formData.append("g-recaptcha-response", token);
  fetch("/api/getPanSearch/", { method: "POST", headers: { "X-CSRFToken": "csrf-123" }, body: formData })
    .then(res => res.json())
    .then(response => {
      if (!response || response.error || response.code === 0 || response === 0) {
        document.getElementById("errdiv").innerHTML = "<p>अवैध जानकारी।</p>";
        return;
      }
      const d = response.data || {};
      const p = (d.panDetails && d.panDetails[0]) || {};
      const regs = d.panRegistrationDetail || [];
      document.getElementById("result").innerHTML = \`
        <div class="card p-3 mt-3"><h4>PAN Detail</h4>
        <table class="table table-bordered">
          <tr><th>PAN</th><td>\${safe(p.pan)}</td></tr>
          <tr><th>Name (Eng)</th><td>\${safe(p.trade_Name_Eng)}</td></tr>
          <tr><th>Name (Nep)</th><td>\${safe(p.trade_Name_Nep)}</td></tr>
          <tr><th>Effective Registration Date</th><td>\${safe(p.eff_Reg_Date)}</td></tr>
        </table>
        <h5 class="mt-4">Registration Details</h5>
        <table class="table table-bordered"><thead><tr><th>Account Type</th><th>Reg. Date</th><th>Filing Period</th><th>Status</th></tr></thead>
        <tbody>\${regs.map(r => \`<tr><td>Income Tax</td><td>\${safe(r.registrationDate)}</td><td>-</td><td>\${r.accountStatus === "A" ? "Active" : "Closed"}</td></tr>\`).join("")}</tbody>
        </table></div>\`;
    })
    .catch(() => { document.getElementById("errdiv").innerHTML = "<p>Something went wrong. Please try again.</p>"; });
}
</script></body></html>`;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      resolve(body);
    });
  });
}

/** The replica: what the search answers depends on the PAN and the token it was sent. */
function replica(mode: { page: 'ok' | 'no-site-key' | 'down' }) {
  const seen: { pan: string; token: string }[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.method === 'GET' && req.url?.startsWith('/pan-search/') === true) {
        if (mode.page === 'down') {
          res.writeHead(503).end('maintenance');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE(mode.page === 'ok'));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/getPanSearch/') {
        const body = await readBody(req);
        const pan = /name="pan"\r\n\r\n([0-9]*)/.exec(body)?.[1] ?? '';
        const token = /name="g-recaptcha-response"\r\n\r\n([^\r]*)/.exec(body)?.[1] ?? '';
        seen.push({ pan, token });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (token !== GOOD_TOKEN || pan !== '302118845') {
          res.end(JSON.stringify({ error: true }));
          return;
        }
        res.end(
          JSON.stringify({
            data: {
              panDetails: [
                {
                  pan: '302118845',
                  trade_Name_Eng: 'THAMEL KIRANA PASAL PVT. LTD.',
                  trade_Name_Nep: 'ठमेल किराना पसल',
                  eff_Reg_Date: '2075-04-01',
                },
              ],
              panRegistrationDetail: [{ registrationDate: '2075-04-01', accountStatus: 'A' }],
            },
          }),
        );
        return;
      }
      res.writeHead(404).end();
    })();
  });
  return { server, seen };
}

async function chromiumOrNull(): Promise<Browser | null> {
  try {
    return await chromium.launch({ headless: true });
  } catch (error: unknown) {
    console.warn(
      `Chromium could not start: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

const solver = (token = GOOD_TOKEN): CaptchaSolver & { tasks: unknown[] } => {
  const tasks: unknown[] = [];
  return {
    tasks,
    solveRecaptchaV2: (task) => {
      tasks.push(task);
      return Promise.resolve(token);
    },
  };
};

describe('the IRD lookup in a real headless Chromium (local replica of the IRD page)', () => {
  let browser: Browser | null;
  const mode: { page: 'ok' | 'no-site-key' | 'down' } = { page: 'ok' };
  let server: Server;
  let seen: { pan: string; token: string }[];
  let url: string;

  beforeAll(async () => {
    browser = await chromiumOrNull();
    const started = replica(mode);
    server = started.server;
    seen = started.seen;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/pan-search/`;
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    mode.page = 'ok';
    seen.length = 0;
  });

  const lookup = (captcha: CaptchaSolver) => {
    const shared = browser;
    if (shared === null) throw new Error('no Chromium');
    return new PlaywrightIrdLookup({
      searchUrl: url,
      solver: captcha,
      proxies: new ProxyRotation([]),
      // The suite's browser; the adapter's close() must not close it.
      launch: () =>
        Promise.resolve({
          ...shared,
          newContext: shared.newContext.bind(shared),
          close: () => Promise.resolve(),
        }),
    });
  };

  const maybe = (name: string, fn: () => Promise<void>) => {
    it(name, async () => {
      if (browser === null) {
        // A missing browser fails the suite: a skipped test must be asked for, never silent.
        if (process.env.SKIP_BROWSER_TESTS === 'true') return;
        throw new Error(
          'Chromium is not installed: run npx playwright-core install chromium, or set SKIP_BROWSER_TESTS=true',
        );
      }
      await fn();
    });
  };

  maybe(
    "solves the CAPTCHA for the page's own site key, submits, and reads the result",
    async () => {
      const captcha = solver();
      await expect(lookup(captcha).lookup('302118845')).resolves.toEqual({
        kind: 'FOUND',
        businessName: 'THAMEL KIRANA PASAL PVT. LTD.',
        registrationDate: '2075-04-01',
        accountStatuses: ['Active'],
      });
      expect(captcha.tasks).toEqual([{ websiteURL: url, websiteKey: SITE_KEY, invisible: true }]);
      expect(seen).toEqual([{ pan: '302118845', token: GOOD_TOKEN }]);
    },
  );

  maybe('reads an unknown PAN as not found', async () => {
    await expect(lookup(solver()).lookup('111111111')).resolves.toEqual({ kind: 'NOT_FOUND' });
  });

  maybe('a refused CAPTCHA token reads as the IRD\'s "invalid information" too', async () => {
    await expect(lookup(solver('wrong-token')).lookup('302118845')).resolves.toEqual({
      kind: 'NOT_FOUND',
    });
  });

  maybe(
    'a page without the reCAPTCHA site key is a layout change, and nothing is solved',
    async () => {
      mode.page = 'no-site-key';
      const captcha = solver();
      await expect(lookup(captcha).lookup('302118845')).resolves.toMatchObject({
        kind: 'LAYOUT_CHANGED',
      });
      expect(captcha.tasks).toEqual([]);
      expect(seen).toEqual([]);
    },
  );

  maybe('a page that is down fails retryably', async () => {
    mode.page = 'down';
    await expect(lookup(solver()).lookup('302118845')).rejects.toThrow(IrdTransientError);
  });
});

describe('the IRD lookup with rotating proxies', () => {
  it('opens each attempt through the next proxy, without the credentials in the error', async () => {
    const contexts: unknown[] = [];
    const fakeBrowser = {
      newContext: (options: unknown) => {
        contexts.push(options);
        return Promise.reject(new Error('net::ERR_PROXY_CONNECTION_FAILED'));
      },
      close: () => Promise.resolve(),
    } as unknown as Browser;
    const adapter = new PlaywrightIrdLookup({
      searchUrl: 'https://ird.gov.np/pan-search/',
      solver: solver(),
      proxies: new ProxyRotation(['http://u:secret@proxy-a:8080', 'http://proxy-b:8080']),
      launch: () => Promise.resolve(fakeBrowser),
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failure = adapter.lookup('302118845');
      await expect(failure).rejects.toThrow(IrdTransientError);
      await failure.catch((error: unknown) => {
        expect(String(error)).not.toContain('secret');
      });
    }
    expect(
      contexts.map((options) => (options as { proxy: { server: string } }).proxy.server),
    ).toEqual(['http://proxy-a:8080', 'http://proxy-b:8080', 'http://proxy-a:8080']);
    expect((contexts[0] as { proxy: unknown }).proxy).toEqual({
      server: 'http://proxy-a:8080',
      username: 'u',
      password: 'secret',
    });
  });
});
