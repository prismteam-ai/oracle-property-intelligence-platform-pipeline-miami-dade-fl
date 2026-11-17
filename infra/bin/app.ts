#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { OracleWebStack } from "../lib/oracle-web-stack";

const app = new App();

// The account comes from the credentials in use; the Region is fixed.
// Deploy with an explicit profile:  npx cdk deploy --profile <your-profile>
new OracleWebStack(app, "MiamiDadeOracleWeb", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-2" },
  geminiKeyParameter: "/miami-dade-oracle/gemini-api-key",
  // Keeps four instances ready during the review period (inside Lambda's free tier). 0 = no schedule.
  keepWarmInstances: 4,
  description: "Miami-Dade Oracle pipeline: hosted runtime (one Lambda function with a public URL)",
});
