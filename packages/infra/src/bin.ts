#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AiInterviewerStack } from "./stack.js";
import dotenv from "dotenv";

dotenv.config();

const app = new cdk.App();
console.log(process.env.CDK_DEFAULT_ACCOUNT, process.env.CDK_DEFAULT_REGION);
new AiInterviewerStack(app, "AiInterviewerPoc", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "eu-west-2",
  },
});
