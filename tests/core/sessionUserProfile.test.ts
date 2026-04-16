// sessionUserProfile.test.ts — SPEC-121: user identity metadata per session.

import { afterEach, describe, expect, test } from 'bun:test';
import { ErrorCode, NimbusError } from '../../src/observability/errors.ts';
import {
  UserProfileSchema,
  getUserProfile,
  requireUserProfile,
  setUserProfile,
  __resetUserProfileStore,
  type UserProfile,
} from '../../src/core/sessionUserProfile.ts';

afterEach(() => {
  __resetUserProfileStore();
});

const SESSION_A = '01H0000000000000000000000A';
const SESSION_B = '01H0000000000000000000000B';

const VALID_PROFILE: UserProfile = {
  channelUserId: 'user-123',
  channelAdapterId: 'telegram',
  displayName: 'Linh',
};

describe('SPEC-121: sessionUserProfile', () => {
  // -----------------------------------------------------------------------
  // Zod schema
  // -----------------------------------------------------------------------

  describe('UserProfileSchema', () => {
    test('accepts full profile', () => {
      expect(() => UserProfileSchema.parse(VALID_PROFILE)).not.toThrow();
    });

    test('accepts profile without displayName', () => {
      const { displayName: _d, ...without } = VALID_PROFILE;
      expect(() => UserProfileSchema.parse(without)).not.toThrow();
    });

    test('rejects missing channelUserId', () => {
      const { channelUserId: _c, ...missing } = VALID_PROFILE;
      expect(() => UserProfileSchema.parse(missing)).toThrow();
    });

    test('rejects empty channelUserId', () => {
      expect(() => UserProfileSchema.parse({ ...VALID_PROFILE, channelUserId: '' })).toThrow();
    });

    test('rejects channelUserId > 256 chars', () => {
      expect(() =>
        UserProfileSchema.parse({ ...VALID_PROFILE, channelUserId: 'x'.repeat(257) }),
      ).toThrow();
    });

    test('rejects displayName > 128 chars', () => {
      expect(() =>
        UserProfileSchema.parse({ ...VALID_PROFILE, displayName: 'x'.repeat(129) }),
      ).toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // setUserProfile / getUserProfile
  // -----------------------------------------------------------------------

  test('set then get returns same profile', async () => {
    await setUserProfile(SESSION_A, VALID_PROFILE);
    const got = await getUserProfile(SESSION_A);
    expect(got).not.toBeNull();
    expect(got!.channelUserId).toBe(VALID_PROFILE.channelUserId);
    expect(got!.channelAdapterId).toBe(VALID_PROFILE.channelAdapterId);
    expect(got!.displayName).toBe(VALID_PROFILE.displayName);
  });

  test('get returns null for unknown sessionId', async () => {
    const got = await getUserProfile('unknown-session');
    expect(got).toBeNull();
  });

  test('profiles are isolated per session', async () => {
    const profileB: UserProfile = { ...VALID_PROFILE, channelUserId: 'user-456', displayName: 'Minh' };
    await setUserProfile(SESSION_A, VALID_PROFILE);
    await setUserProfile(SESSION_B, profileB);
    const a = await getUserProfile(SESSION_A);
    const b = await getUserProfile(SESSION_B);
    expect(a!.channelUserId).toBe('user-123');
    expect(b!.channelUserId).toBe('user-456');
  });

  test('setUserProfile strips HTML from displayName', async () => {
    const injected: UserProfile = { ...VALID_PROFILE, displayName: '<script>alert(1)</script>Linh' };
    await setUserProfile(SESSION_A, injected);
    const got = await getUserProfile(SESSION_A);
    expect(got!.displayName).not.toContain('<script>');
    expect(got!.displayName).toContain('Linh');
  });

  test('setUserProfile strips ANSI from displayName', async () => {
    const ansiName = '\u001b[31mRedName\u001b[0m';
    await setUserProfile(SESSION_A, { ...VALID_PROFILE, displayName: ansiName });
    const got = await getUserProfile(SESSION_A);
    expect(got!.displayName).not.toMatch(/\u001b/);
    expect(got!.displayName).toContain('RedName');
  });

  test('profile is updatable mid-session (displayName can change)', async () => {
    await setUserProfile(SESSION_A, VALID_PROFILE);
    await setUserProfile(SESSION_A, { ...VALID_PROFILE, displayName: 'Updated' });
    const got = await getUserProfile(SESSION_A);
    expect(got!.displayName).toBe('Updated');
  });

  // -----------------------------------------------------------------------
  // requireUserProfile
  // -----------------------------------------------------------------------

  test('requireUserProfile returns profile when set', async () => {
    await setUserProfile(SESSION_A, VALID_PROFILE);
    const got = await requireUserProfile(SESSION_A);
    expect(got.channelUserId).toBe(VALID_PROFILE.channelUserId);
  });

  test('requireUserProfile throws NimbusError T_NOT_FOUND for unknown session', async () => {
    try {
      await requireUserProfile('non-existent-session');
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.T_NOT_FOUND);
    }
  });

  // -----------------------------------------------------------------------
  // Performance
  // -----------------------------------------------------------------------

  test('getUserProfile is fast (< 2ms warm)', async () => {
    await setUserProfile(SESSION_A, VALID_PROFILE);
    const start = performance.now();
    await getUserProfile(SESSION_A);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2);
  });
});
