import { PreSignUpTriggerEvent } from "aws-lambda";
import { decidePreSignUp } from "../pre-sign-up-decision";

export const handler = async (event: PreSignUpTriggerEvent): Promise<PreSignUpTriggerEvent> => {
  const email = event.request.userAttributes.email;
  const triggerSource = event.triggerSource;
  const decision = decidePreSignUp(triggerSource, email, process.env.GOOGLE_ONLY === "true");

  if (!decision.allow) {
    throw new Error(decision.reason || "Sign-up not allowed");
  }

  // Apply auto-confirmation decision (only for external providers like Google)
  event.response.autoConfirmUser = decision.autoConfirm;
  event.response.autoVerifyEmail = decision.autoVerifyEmail;

  return event;
};
