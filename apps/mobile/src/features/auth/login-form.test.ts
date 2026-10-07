import {
  formatNepalPhone,
  isCompleteOtp,
  leaveSignIn,
  sanitizeOtpInput,
  sanitizePhoneInput,
  toNepalPhone,
  toTenDigitNepalPhone,
} from './login-form';

describe('toNepalPhone', () => {
  it('turns a typed Nepal mobile number into strict +977 E.164', () => {
    expect(toNepalPhone('9800000001')).toBe('+9779800000001');
    expect(toNepalPhone(' 980-000-0001 ')).toBe('+9779800000001');
    expect(toNepalPhone('९८०००००००१')).toBe('+9779800000001');
    expect(toNepalPhone('+977 9800000001')).toBe('+9779800000001');
  });

  it('rejects anything the shared +977 regex rejects', () => {
    for (const input of ['', '12345', '8800000001', '98000000012', '+91 9800000001', 'abc']) {
      expect(toNepalPhone(input)).toBeNull();
    }
  });
});

describe('sign-in number field', () => {
  it('keeps at most ten ASCII digits, whatever is typed or pasted', () => {
    expect(sanitizePhoneInput('98000000012345')).toBe('9800000001');
    expect(sanitizePhoneInput('980-000 0001')).toBe('9800000001');
    expect(sanitizePhoneInput('९८०००००००१')).toBe('9800000001');
    expect(sanitizePhoneInput('98a0')).toBe('980');
    expect(sanitizePhoneInput('')).toBe('');
  });

  it('takes a pasted +977 or 977 prefix off before counting', () => {
    expect(sanitizePhoneInput('+977 9800000001')).toBe('9800000001');
    expect(sanitizePhoneInput('9779800000001')).toBe('9800000001');
    // A number that merely starts with 977 is not a prefix until there are more than ten digits.
    expect(sanitizePhoneInput('9771234567')).toBe('9771234567');
  });

  it('is a phone number only at exactly ten digits starting with 9', () => {
    expect(toTenDigitNepalPhone('9800000001')).toBe('+9779800000001');
    for (const digits of ['', '980000000', '98000000012', '8800000001', '+9779800000001']) {
      expect(toTenDigitNepalPhone(digits)).toBeNull();
    }
  });
});

describe('OTP input', () => {
  it('keeps ASCII digits only, converts Nepali digits and caps at 6', () => {
    expect(sanitizeOtpInput('04 21-87')).toBe('042187');
    expect(sanitizeOtpInput('०४२१८७')).toBe('042187');
    expect(sanitizeOtpInput('1234567')).toBe('123456');
  });

  it('is complete at exactly 6 digits', () => {
    expect(isCompleteOtp('042187')).toBe(true);
    expect(isCompleteOtp('04218')).toBe(false);
  });
});

describe('formatNepalPhone', () => {
  it('separates the country code for display', () => {
    expect(formatNepalPhone('+9779800000001')).toBe('+977 9800000001');
  });
});

describe('leaveSignIn', () => {
  const navigator = (canGoBack: boolean) => ({
    canGoBack: jest.fn(() => canGoBack),
    back: jest.fn(),
    replace: jest.fn(),
  });

  it('returns to the screen that asked for sign-in', () => {
    const router = navigator(true);
    leaveSignIn(router);
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('opens the Feed when sign-in was the first screen', () => {
    const router = navigator(false);
    leaveSignIn(router);
    expect(router.replace).toHaveBeenCalledWith('/');
    expect(router.back).not.toHaveBeenCalled();
  });
});
