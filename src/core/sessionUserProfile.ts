// sessionUserProfile.ts — SPEC-121: user identity metadata per session.

import { z } from 'zod';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { logger } from '../observability/logger.ts';

// ---------------------------------------------------------------------------
// Schema + Types
// ---------------------------------------------------------------------------

export const UserProfileSchema = z.object({
  channelUserId: z.string().min(1).max(256),
  channelAdapterId: z.string().min(1).max(64),
  displayName: z.string().max(128).optional(),
});

export type UserProfile = z.infer<typeof UserProfileSchema>;

// ---------------------------------------------------------------------------
// Sanitisation — strip HTML tags from displayName to prevent injection
// ---------------------------------------------------------------------------

function sanitizeDisplayName(name: string): string {
  return name
    .replace(/<[^>]*>/g, '')   // strip HTML tags
    .replace(/[\u001b\u009b]\[[0-9;]*m/g, '')  // strip ANSI colour codes
    .slice(0, 128);
}

// ---------------------------------------------------------------------------
// In-process store (keyed by sessionId)
// ---------------------------------------------------------------------------

const profileStore = new Map<string, UserProfile>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function setUserProfile(sessionId: string, profile: UserProfile): Promise<void> {
  const validated = UserProfileSchema.parse(profile);
  const sanitized: UserProfile = {
    ...validated,
    displayName: validated.displayName !== undefined
      ? sanitizeDisplayName(validated.displayName)
      : undefined,
  };
  profileStore.set(sessionId, sanitized);
  logger.debug({ sessionId, channelAdapterId: sanitized.channelAdapterId }, 'userProfile.set');
}

export async function getUserProfile(sessionId: string): Promise<UserProfile | null> {
  const profile = profileStore.get(sessionId);
  if (!profile) return null;
  return profile;
}

export function getUserProfileSync(sessionId: string): UserProfile | null {
  return profileStore.get(sessionId) ?? null;
}

/**
 * Called from channel adapters when they need to ensure a profile exists before
 * continuing — throws NimbusError T_NOT_FOUND if not set and throwIfMissing=true.
 */
export async function requireUserProfile(sessionId: string): Promise<UserProfile> {
  const profile = profileStore.get(sessionId);
  if (!profile) {
    throw new NimbusError(ErrorCode.T_NOT_FOUND, {
      reason: 'user_profile_not_found',
      sessionId,
    });
  }
  return profile;
}

export function __resetUserProfileStore(): void {
  profileStore.clear();
}
