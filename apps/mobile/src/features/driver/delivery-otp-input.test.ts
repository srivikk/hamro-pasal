import {
  isCompleteDeliveryOtp,
  lockoutMinutes,
  sanitizeDeliveryOtpInput,
} from './delivery-otp-input';

describe('sanitizeDeliveryOtpInput', () => {
  it.each([
    ['1234', '1234'],
    ['0042', '0042'], // leading zeros are part of the code
    ['12 34', '1234'],
    ['12-34', '1234'],
    ['a1b2c3d4', '1234'],
    ['१२३४', '1234'], // Nepali keyboard digits
    ['१2३4', '1234'],
    ['123456', '1234'], // pasted too much: only the first 4 digits
    ['', ''],
    ['abc', ''],
  ])('keeps %p as %p', (input, expected) => {
    expect(sanitizeDeliveryOtpInput(input)).toBe(expected);
  });
});

describe('isCompleteDeliveryOtp', () => {
  it('is true only for exactly 4 ASCII digits', () => {
    expect(isCompleteDeliveryOtp('1234')).toBe(true);
    expect(isCompleteDeliveryOtp('0000')).toBe(true);
    expect(isCompleteDeliveryOtp('123')).toBe(false);
    expect(isCompleteDeliveryOtp('12345')).toBe(false);
    expect(isCompleteDeliveryOtp('12a4')).toBe(false);
    expect(isCompleteDeliveryOtp('१२३४')).toBe(false);
    expect(isCompleteDeliveryOtp('')).toBe(false);
  });
});

describe('lockoutMinutes', () => {
  it('rounds the wait up to whole minutes, at least one', () => {
    expect(lockoutMinutes(900)).toBe(15);
    expect(lockoutMinutes(899)).toBe(15);
    expect(lockoutMinutes(61)).toBe(2);
    expect(lockoutMinutes(1)).toBe(1);
  });
});
