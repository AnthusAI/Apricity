/**
 * Check if an email is in the allowed list.
 * @param email The email to check (will be normalized to lowercase)
 * @param allowedList Comma-separated list of allowed emails (case-insensitive)
 * @returns true if the email is allowed, false otherwise
 */
export function isAllowed(email: string, allowedList: string): boolean {
  if (!email || !allowedList) {
    return false;
  }

  const normalizedEmail = email.toLowerCase().trim();
  const allowedEmails = allowedList
    .split(",")
    .map((e) => e.toLowerCase().trim())
    .filter((e) => e.length > 0);

  return allowedEmails.includes(normalizedEmail);
}
