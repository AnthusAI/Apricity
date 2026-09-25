import { isAllowed } from "./allow-list";

export interface PreSignUpDecision {
  allow: boolean;
  autoConfirm: boolean;
  autoVerifyEmail: boolean;
  reason?: string;
}

/**
 * Decide whether to allow and auto-confirm a sign-up based on trigger source and email allowlist.
 *
 * Security rules:
 * - External provider (Google): auto-confirm if email is allowed (provider already verified)
 * - Email/password: allow if email is allowed, but require normal email verification (no auto-confirm)
 * - Not allowed or missing email: reject the sign-up
 *
 * @param triggerSource The Cognito trigger source (e.g., "PreSignUp_SignUp" or "PreSignUp_ExternalProvider")
 * @param email The user's email from userAttributes
 * @param allowedList Comma-separated list of allowed emails
 * @returns Decision object with allow, autoConfirm, autoVerifyEmail flags
 */
export function decidePreSignUp(
  triggerSource: string,
  email: string | undefined,
  allowedList: string,
  googleOnly = false
): PreSignUpDecision {
  // Google-only: a native (email + password) sign-up is refused; only external-provider sign-ups pass on.
  if (googleOnly && triggerSource === "PreSignUp_SignUp") {
    return {
      allow: false,
      autoConfirm: false,
      autoVerifyEmail: false,
      reason: "Sign in with Google",
    };
  }

  // Missing email is always rejected
  if (!email) {
    return {
      allow: false,
      autoConfirm: false,
      autoVerifyEmail: false,
      reason: "Missing email in user attributes",
    };
  }

  // Check if email is in the allowed list
  if (!isAllowed(email, allowedList)) {
    return {
      allow: false,
      autoConfirm: false,
      autoVerifyEmail: false,
      reason: `Email ${email} is not in the allowed list`,
    };
  }

  // Email is allowed; now decide on auto-confirmation based on trigger source
  const isExternalProvider = triggerSource === "PreSignUp_ExternalProvider";

  if (isExternalProvider) {
    // Google has already verified the email; auto-confirm and verify
    return {
      allow: true,
      autoConfirm: true,
      autoVerifyEmail: true,
      reason: "External provider (Google) - auto-confirm verified email",
    };
  } else {
    // Email/password sign-up: allow but require normal email verification
    return {
      allow: true,
      autoConfirm: false,
      autoVerifyEmail: false,
      reason: "Email/password sign-up - requires email verification",
    };
  }
}
