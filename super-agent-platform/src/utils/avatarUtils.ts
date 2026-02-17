/**
 * Avatar Utilities
 * 
 * Handles avatar URL resolution for agents.
 * Supports S3 keys, external URLs, and fallback characters.
 */

import { getRestApiConfig } from '@/services/api/restClient';

/**
 * Checks if the avatar value is an S3 key (generated image)
 */
export function isS3AvatarKey(avatar: string | null | undefined): boolean {
  if (!avatar) return false;
  return avatar.startsWith('avatars/');
}

/**
 * Checks if the avatar value is a URL (external image)
 */
export function isAvatarUrl(avatar: string | null | undefined): boolean {
  if (!avatar) return false;
  return avatar.startsWith('http://') || 
         avatar.startsWith('https://') || 
         avatar.startsWith('data:image/');
}

/**
 * Gets the display URL for an avatar.
 * - For S3 keys: returns the backend avatar endpoint URL
 * - For URLs: returns the URL as-is
 * - For characters/fallback: returns null (component should show character)
 */
export function getAvatarDisplayUrl(avatar: string | null | undefined): string | null {
  if (!avatar) return null;
  
  // S3 key - construct backend URL
  if (isS3AvatarKey(avatar)) {
    const { baseUrl } = getRestApiConfig();
    // The avatar field stores the full S3 key like "avatars/123-abc.png"
    // The backend endpoint is /api/avatars/* which expects just the filename
    // Extract just the filename from the S3 key
    const filename = avatar.replace('avatars/', '');
    return `${baseUrl}/api/avatars/${filename}`;
  }
  
  // External URL or data URL
  if (isAvatarUrl(avatar)) {
    return avatar;
  }
  
  // Character/emoji fallback - return null so component shows the character
  return null;
}

/**
 * Gets the fallback character for an avatar (first character of display name)
 */
export function getAvatarFallback(displayName: string, avatar?: string | null): string {
  // If avatar is a character/emoji (not URL or S3 key), use it
  if (avatar && !isS3AvatarKey(avatar) && !isAvatarUrl(avatar)) {
    return avatar;
  }
  // Otherwise use first character of display name
  return displayName.charAt(0).toUpperCase();
}

/**
 * Determines if the avatar should be displayed as an image
 */
export function shouldShowAvatarImage(avatar: string | null | undefined): boolean {
  return isS3AvatarKey(avatar) || isAvatarUrl(avatar);
}
