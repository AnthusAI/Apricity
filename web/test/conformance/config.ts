import { Amplify } from "aws-amplify";
import fs from "fs";
import https from "https";
import http from "http";

export interface AmplifyConfig {
  auth: {
    Cognito: {
      userPoolId: string;
      userPoolClientId: string;
      region: string;
    };
  };
  api: {
    GraphQL: {
      endpoint: string;
      region: string;
      defaultAuthorizationMode: string;
      authorizationModes: {
        apiKey: {
          apiKey: string;
          expiresInDays: number;
        };
        userPool: Record<string, unknown>;
        identityPool?: Record<string, unknown>;
      };
    };
  };
}

/**
 * Load Amplify configuration from TARGET_OUTPUTS env var
 * (a file path or URL like http://127.0.0.1:5181/amplify_outputs.json)
 */
export async function loadAmplifyConfig(): Promise<void> {
  const targetOutputs = process.env.TARGET_OUTPUTS;
  if (!targetOutputs) {
    throw new Error("TARGET_OUTPUTS env var not set");
  }

  let configText: string;

  if (targetOutputs.startsWith("http://") || targetOutputs.startsWith("https://")) {
    // Fetch from URL
    configText = await fetchUrl(targetOutputs);
  } else {
    // Load from file
    configText = fs.readFileSync(targetOutputs, "utf-8");
  }

  const config = JSON.parse(configText) as AmplifyConfig;
  Amplify.configure(config);
}

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https://") ? https : http;
    client
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve(data);
        });
      })
      .on("error", reject);
  });
}
