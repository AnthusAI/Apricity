export interface PreSignUpDecision {
  allow: boolean;
  autoConfirm: boolean;
  autoVerifyEmail: boolean;
  reason?: string;
}

/**
 * Decide whether to allow and auto-confirm a sign-up. The site is public: anyone may sign in to rate and create.
 *
 * - External provider (Google): allowed and auto-confirmed (the provider verified the email).
 * - Email/password: refused while sign-in is Google only; otherwise allowed with normal email verification.
 * - Missing email: refused.
 *
 * @param triggerSource The Cognito trigger source (e.g., "PreSignUp_SignUp" or "PreSignUp_ExternalProvider")
 * @param email The user's email from userAttributes
 * @param googleOnly Whether sign-in is Google only
 */
export function decidePreSignUp(triggerSource: string, email: string | undefined, googleOnly = false): PreSignUpDecision {
  if (googleOnly && triggerSource === "PreSignUp_SignUp") {
    return { allow: false, autoConfirm: false, autoVerifyEmail: false, reason: "Sign in with Google" };
  }
  if (!email) {
    return { allow: false, autoConfirm: false, autoVerifyEmail: false, reason: "Missing email in user attributes" };
  }
  if (triggerSource === "PreSignUp_ExternalProvider") {
    return { allow: true, autoConfirm: true, autoVerifyEmail: true, reason: "External provider (Google) - auto-confirm verified email" };
  }
  return { allow: true, autoConfirm: false, autoVerifyEmail: false, reason: "Email/password sign-up - requires email verification" };
}
