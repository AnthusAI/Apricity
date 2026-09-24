import {
  AdminAddUserToGroupCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { PostConfirmationTriggerEvent } from "aws-lambda";

const cognito = new CognitoIdentityProviderClient();

export const handler = async (
  event: PostConfirmationTriggerEvent
): Promise<PostConfirmationTriggerEvent> => {
  const userPoolId = event.userPoolId;
  const username = event.userName;

  try {
    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: userPoolId,
        Username: username,
        GroupName: "members",
      })
    );
  } catch (error) {
    console.error(`Failed to add user ${username} to members group:`, error);
    throw error;
  }

  return event;
};
