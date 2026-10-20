import { panCheckSchedulerConsumer } from '../consumers/pan-check-scheduler';
import { IrdTransientError, withTimeout } from './ird-lookup';
import { htmlText, parseIrdResult } from './ird-result-parser';
import { describeProxy, ProxyRotation, toBrowserProxy } from './proxy-rotation';
import { TwoCaptchaSolver } from './two-captcha';

/**
 * The IRD result exactly as the page's own script renders it (https://ird.gov.np/pan-search/,
 * `onSubmit` in the page, read 2026-10-21): the "PAN Detail" table, then "Business Details",
 * then "Registration Details" with each registration's status in the 4th column.
 */
function renderedResult(fields: {
  nameEng?: string;
  nameNep?: string;
  regDate?: string;
  statuses?: string[];
}): string {
  const safe = (value: string | undefined) => (value === undefined || value === '' ? '-' : value);
  const rows = (fields.statuses ?? ['Active'])
    .map(
      (status) => `
        <tr class="">
          <td>Income Tax</td>
          <td>2075-04-01</td>
          <td>Monthly</td>
          <td>${status}</td>
        </tr>`,
    )
    .join('');
  return `
    <div class="card p-3 mt-3">
      <h4 class="mb-3">PAN Detail</h4>
      <table class="table table-bordered">
        <tr><th>PAN</th><td>302118845</td></tr>
        <tr><th>Name (Eng)</th><td>${safe(fields.nameEng)}</td></tr>
        <tr><th>Name (Nep)</th><td>${safe(fields.nameNep)}</td></tr>
        <tr><th>Address</th><td>Kathmandu Thamel Marg</td></tr>
        <tr><th>Ward</th><td>26</td></tr>
        <tr><th>Office</th><td>IRO Kathmandu</td></tr>
        <tr><th>Effective Registration Date</th><td>${safe(fields.regDate)}</td></tr>
      </table>
      <h5 class="mt-4">Business Details</h5>
      <table class="table table-striped table-bordered">
        <thead><tr><th>Trade Name (Eng)</th><th>Trade Name (Nep)</th><th>Main Business</th></tr></thead>
        <tbody><tr><td>${safe(fields.nameEng)}</td><td>-</td><td>Y</td></tr></tbody>
      </table>
      <h5 class="mt-4">Registration Details</h5>
      <table class="table table-bordered">
        <thead><tr><th>Account Type</th><th>Reg. Date</th><th>Filing Period</th><th>Status</th></tr></thead>
        <tbody>${rows.length > 0 ? rows : '<tr><td colspan="4">-</td></tr>'}</tbody>
      </table>
    </div>`;
}

describe('the IRD result parser', () => {
  it('reads the business name, the registration date and the statuses', () => {
    expect(
      parseIrdResult({
        resultHtml: renderedResult({
          nameEng: 'THAMEL KIRANA PASAL PVT. LTD.',
          regDate: '2075-04-01',
          statuses: ['Active', 'Closed'],
        }),
        errorText: '',
      }),
    ).toEqual({
      kind: 'FOUND',
      businessName: 'THAMEL KIRANA PASAL PVT. LTD.',
      registrationDate: '2075-04-01',
      accountStatuses: ['Active', 'Closed'],
    });
  });

  it('falls back to the Nepali name, reads "-" as no value, and decodes entities', () => {
    expect(
      parseIrdResult({
        resultHtml: renderedResult({ nameNep: 'राम &amp; सीता ट्रेडर्स', statuses: [] }),
        errorText: '',
      }),
    ).toEqual({
      kind: 'FOUND',
      businessName: 'राम & सीता ट्रेडर्स',
      registrationDate: null,
      accountStatuses: [],
    });
    expect(htmlText('<b>A</b>&nbsp;&#39;B&#x27;')).toBe("A 'B'");
  });

  it('reads the IRD\'s "invalid information" as not found', () => {
    expect(parseIrdResult({ resultHtml: '', errorText: 'अवैध जानकारी।' })).toEqual({
      kind: 'NOT_FOUND',
    });
  });

  it('throws a retryable error for the page\'s "something went wrong"', () => {
    expect(() =>
      parseIrdResult({ resultHtml: '', errorText: 'Something went wrong. Please try again.' }),
    ).toThrow(IrdTransientError);
  });

  it('calls anything else a layout change', () => {
    expect(parseIrdResult({ resultHtml: '', errorText: '' })).toMatchObject({
      kind: 'LAYOUT_CHANGED',
    });
    expect(parseIrdResult({ resultHtml: '', errorText: 'Under maintenance' })).toMatchObject({
      kind: 'LAYOUT_CHANGED',
      detail: 'an unknown message: "Under maintenance"',
    });
    expect(
      parseIrdResult({
        resultHtml: '<table><tr><th>Owner</th><td>X</td></tr></table>',
        errorText: '',
      }),
    ).toMatchObject({ kind: 'LAYOUT_CHANGED' });
  });
});

describe('2Captcha', () => {
  function fakeApi(answers: unknown[]) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) as Record<string, unknown> });
      const answer = answers.shift();
      if (answer instanceof Error) return Promise.reject(answer);
      if (typeof answer === 'number') return Promise.resolve(new Response('', { status: answer }));
      return Promise.resolve(Response.json(answer));
    }) as typeof fetch;
    return { calls, fetchImpl };
  }
  const solver = (fetchImpl: typeof fetch, budgetMs?: number) => {
    let clock = 0;
    return new TwoCaptchaSolver({
      apiKey: 'secret-key',
      fetch: fetchImpl,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
      ...(budgetMs === undefined ? {} : { budgetMs }),
    });
  };
  const TASK = {
    websiteURL: 'https://ird.gov.np/pan-search/',
    websiteKey: 'site-key',
    invisible: true,
  };

  it('creates a reCAPTCHA v2 task, polls until ready, and returns the token', async () => {
    const api = fakeApi([
      { errorId: 0, taskId: 42 },
      { errorId: 0, status: 'processing' },
      { errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'token-123' } },
    ]);
    await expect(solver(api.fetchImpl).solveRecaptchaV2(TASK)).resolves.toBe('token-123');
    expect(api.calls[0]).toEqual({
      url: 'https://api.2captcha.com/createTask',
      body: {
        clientKey: 'secret-key',
        task: {
          type: 'RecaptchaV2TaskProxyless',
          websiteURL: 'https://ird.gov.np/pan-search/',
          websiteKey: 'site-key',
          isInvisible: true,
        },
      },
    });
    expect(api.calls.slice(1).map((call) => [call.url, call.body.taskId])).toEqual([
      ['https://api.2captcha.com/getTaskResult', 42],
      ['https://api.2captcha.com/getTaskResult', 42],
    ]);
  });

  it.each([
    ['a refused task', [{ errorId: 10, errorCode: 'ERROR_ZERO_BALANCE' }], /ERROR_ZERO_BALANCE/],
    [
      'an unsolvable CAPTCHA',
      [
        { errorId: 0, taskId: 1 },
        { errorId: 12, errorCode: 'ERROR_CAPTCHA_UNSOLVABLE' },
      ],
      /ERROR_CAPTCHA_UNSOLVABLE/,
    ],
    ['an HTTP error', [503], /HTTP 503/],
    ['an unreachable service', [new TypeError('fetch failed')], /unreachable/],
  ])('fails retryably on %s, never naming the key', async (_what, answers, message) => {
    const api = fakeApi(answers);
    const failure = solver(api.fetchImpl).solveRecaptchaV2(TASK);
    await expect(failure).rejects.toThrow(IrdTransientError);
    await expect(failure).rejects.toThrow(message);
    await failure.catch((error: unknown) => {
      expect(String(error)).not.toContain('secret-key');
    });
  });

  it('gives up when the solve outruns its budget', async () => {
    const api = fakeApi(
      Array.from({ length: 50 }, (_, i) =>
        i === 0 ? { errorId: 0, taskId: 1 } : { errorId: 0, status: 'processing' },
      ),
    );
    await expect(solver(api.fetchImpl, 30_000).solveRecaptchaV2(TASK)).rejects.toThrow(
      /did not solve the CAPTCHA within 30 s/,
    );
  });
});

describe('proxy rotation', () => {
  it('splits the credentials off and takes the proxies in turn', () => {
    expect(toBrowserProxy('http://user%40x:p%3Ass@proxy-a:8080')).toEqual({
      server: 'http://proxy-a:8080',
      username: 'user@x',
      password: 'p:ss',
    });
    const rotation = new ProxyRotation(['http://proxy-a:8080', 'socks5://proxy-b:1080']);
    expect([rotation.next(), rotation.next(), rotation.next()].map(describeProxy)).toEqual([
      'http://proxy-a:8080',
      'socks5://proxy-b:1080',
      'http://proxy-a:8080',
    ]);
  });

  it('goes direct without a list', () => {
    const rotation = new ProxyRotation([]);
    expect(rotation.next()).toBeUndefined();
    expect(describeProxy(undefined)).toBe('direct');
  });
});

describe('the timeout guard', () => {
  it('rejects retryably once the time is up, and passes a result through', async () => {
    jest.useFakeTimers();
    try {
      const slow = withTimeout(new Promise<never>(() => undefined), 30_000, 'the IRD page');
      jest.advanceTimersByTime(30_000);
      await expect(slow).rejects.toThrow('the IRD page timed out after 30 s');
    } finally {
      jest.useRealTimers();
    }
    await expect(withTimeout(Promise.resolve(1), 1000, 'x')).resolves.toBe(1);
  });
});

describe('the pan check scheduler consumer', () => {
  const message = (event: unknown) => ({
    message: { value: Buffer.from(JSON.stringify(event)) },
  });

  it('queues the check of a requested event, and ignores every other event', async () => {
    const schedule = jest.fn(() => Promise.resolve());
    const consumer = panCheckSchedulerConsumer({ scheduler: { schedule } });
    const requested = {
      event_id: '7b1f0c8e-0000-4000-8000-000000000001',
      event_type: 'vendor.pan_check_requested',
      event_version: 1,
      aggregate_id: '7b1f0c8e-0000-4000-8000-000000000002',
      occurred_at: '2026-10-21T06:00:00.000Z',
      payload: {
        check_id: '7b1f0c8e-0000-4000-8000-000000000003',
        vendor_id: '7b1f0c8e-0000-4000-8000-000000000002',
        tax_id: '302118845',
        requested_at: '2026-10-21T06:00:00.000Z',
      },
    };
    await consumer.handle(message(requested) as never);
    expect(schedule).toHaveBeenCalledWith(
      '7b1f0c8e-0000-4000-8000-000000000003',
      '2026-10-21T06:00:00.000Z',
    );
    await consumer.handle(
      message({
        ...requested,
        event_type: 'export.requested',
        payload: { job_id: requested.payload.check_id },
      }) as never,
    );
    expect(schedule).toHaveBeenCalledTimes(1);
  });
});
