import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import * as amplify from "aws-cdk-lib/aws-amplify";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Int from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as sfnTasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import type { Construct } from "constructs";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const functionsEntry = path.join(dirname, "../../functions/src/lambda.ts");
const scoreEntry = path.join(dirname, "../../functions/src/score-lambda.ts");

export class AiInterviewerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const userPool = new cognito.UserPool(this, "Recruiters", {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: { minLength: 8 },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const userPoolClient = userPool.addClient("WebClient", {
      authFlows: { userPassword: true, userSrp: true },
    });

    const table = new dynamodb.Table(this, "Table", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    table.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
    });

    const recordings = new s3.Bucket(this, "Recordings", {
      bucketName: "ai-interviewer-recordings-poc-rushi",
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
        },
      ],
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const openaiSecret = new secretsmanager.Secret(this, "OpenAiKey", {
      secretName: "ai-interviewer/openai",
      description: "OpenAI API key for Realtime interviews",
    });

    const webOrigin = this.node.tryGetContext("webOrigin") || "http://localhost:3000";
    const bedrockModelId =
      this.node.tryGetContext("bedrockModelId") || "anthropic.claude-3-5-sonnet-20241022-v2:0";

    const apiFn = new lambdaNode.NodejsFunction(this, "ApiFn", {
      entry: functionsEntry,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(29),
      memorySize: 512,
      bundling: {
        format: lambdaNode.OutputFormat.ESM,
        target: "node22",
        sourceMap: true,
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
      environment: {
        TABLE_NAME: table.tableName,
        RECORDINGS_BUCKET: recordings.bucketName,
        WEB_ORIGIN: webOrigin,
        BEDROCK_MODEL_ID: bedrockModelId,
        OPENAI_REALTIME_MODEL: "gpt-realtime-2.1-mini",
      },
    });
    table.grantReadWriteData(apiFn);
    recordings.grantReadWrite(apiFn);
    openaiSecret.grantRead(apiFn);
    apiFn.addEnvironment("OPENAI_SECRET_ARN", openaiSecret.secretArn);
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: ["*"],
      }),
    );

    const allowOrigins = [
      ...new Set([webOrigin, "http://localhost:3000", "http://127.0.0.1:3000"]),
    ];
    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      corsPreflight: {
        allowOrigins,
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ["content-type", "authorization"],
      },
    });
    httpApi.addRoutes({
      path: "/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: new apigwv2Int.HttpLambdaIntegration("ApiInt", apiFn),
    });
    httpApi.addRoutes({
      path: "/",
      methods: [apigwv2.HttpMethod.ANY],
      integration: new apigwv2Int.HttpLambdaIntegration("ApiRoot", apiFn),
    });

    const scoreFn = new lambdaNode.NodejsFunction(this, "ScoreFn", {
      entry: scoreEntry,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      bundling: {
        format: lambdaNode.OutputFormat.ESM,
        target: "node22",
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
      environment: {
        TABLE_NAME: table.tableName,
        BEDROCK_MODEL_ID: bedrockModelId,
        OPENAI_SECRET_ARN: openaiSecret.secretArn,
        OPENAI_SCORE_MODEL: "gpt-4o-mini",
      },
    });
    table.grantReadWriteData(scoreFn);
    openaiSecret.grantRead(scoreFn);
    scoreFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: ["*"],
      }),
    );

    const scoreTask = new sfnTasks.LambdaInvoke(this, "ScoreTask", {
      lambdaFunction: scoreFn,
      payloadResponseOnly: true,
    });
    const machine = new sfn.StateMachine(this, "ScoringMachine", {
      definitionBody: sfn.DefinitionBody.fromChainable(scoreTask),
      timeout: cdk.Duration.minutes(5),
    });

    const bus = new events.EventBus(this, "InterviewBus");
    new events.Rule(this, "InterviewCompleted", {
      eventBus: bus,
      eventPattern: {
        source: ["ai-interviewer"],
        detailType: ["interview.completed"],
      },
      targets: [
        new targets.SfnStateMachine(machine, {
          input: events.RuleTargetInput.fromEventPath("$.detail"),
        }),
      ],
    });
    bus.grantPutEventsTo(apiFn);
    apiFn.addEnvironment("EVENT_BUS_NAME", bus.eventBusName);

    const amplifyApp = new amplify.CfnApp(this, "WebApp", {
      name: "ai-interviewer-web",
      platform: "WEB_COMPUTE",
      environmentVariables: [
        { name: "NEXT_PUBLIC_API_URL", value: httpApi.apiEndpoint },
        { name: "NEXT_PUBLIC_USER_POOL_ID", value: userPool.userPoolId },
        { name: "NEXT_PUBLIC_USER_POOL_CLIENT_ID", value: userPoolClient.userPoolClientId },
        { name: "NEXT_PUBLIC_AUTH_MODE", value: "cognito" },
        { name: "AMPLIFY_MONOREPO_APP_ROOT", value: "apps/web" },
      ],
    });
    new amplify.CfnBranch(this, "MainBranch", {
      appId: amplifyApp.attrAppId,
      branchName: "main",
      enableAutoBuild: false,
      stage: "PRODUCTION",
    });

    new cdk.CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, "TableName", { value: table.tableName });
    new cdk.CfnOutput(this, "RecordingsBucket", { value: recordings.bucketName });
    new cdk.CfnOutput(this, "OpenAiSecretArn", { value: openaiSecret.secretArn });
    new cdk.CfnOutput(this, "AmplifyAppId", { value: amplifyApp.attrAppId });
    new cdk.CfnOutput(this, "ScoringStateMachineArn", { value: machine.stateMachineArn });
  }
}
