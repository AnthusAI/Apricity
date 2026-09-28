/**
 * The members/curators Cognito group roles replace the authenticated identity-pool role. Grant cycle writes on those
 * roles with the Cognito identity ID embedded in the object ARN, preserving the same per-identity boundary as
 * `allow.entity("identity")` for users who are not assigned to a group.
 */
export const cycleUploadPolicy = (bucketArn: string) => ({
  actions: ["s3:PutObject", "s3:DeleteObject"],
  resources: [`${bucketArn}/files/cycles/\${cognito-identity.amazonaws.com:sub}/*`],
});
