import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { deferredResponse, messageResponse, postInteractionFollowup, verifyDiscordSignature } from '../shared/discord';

// EC2Client and the SSM-backed runRemoteCommand are only needed for the
// /status follow-up, which runs in its own separate self-invocation -- not on
// Discord's 3-second clock. Importing them lazily there keeps them out of the
// cold-start cost paid by every invocation (PING, /start, /stop included).
const lambdaClient = new LambdaClient({});

const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY!;
const WAKE_FUNCTION_NAME = process.env.WAKE_FUNCTION_NAME!;
const STOP_FUNCTION_NAME = process.env.STOP_FUNCTION_NAME!;
const INSTANCE_ID = process.env.INSTANCE_ID!;
const MAX_PLAYERS = process.env.MAX_PLAYERS ?? '3';
const CONNECT_HOSTNAME = process.env.CONNECT_HOSTNAME ?? '';

const DISCORD_PING = 1;
const DISCORD_APPLICATION_COMMAND = 2;

interface FollowupTask {
  readonly task: 'status-followup' | 'cost-followup';
  readonly applicationId: string;
  readonly interactionToken: string;
}

type IncomingEvent = APIGatewayProxyEventV2 | FollowupTask;

function isFollowupTask(event: IncomingEvent): event is FollowupTask {
  const task = (event as FollowupTask).task;
  return task === 'status-followup' || task === 'cost-followup';
}

export async function handler(
  event: IncomingEvent,
  context: Context,
): Promise<APIGatewayProxyResultV2 | void> {
  if (isFollowupTask(event)) {
    if (event.task === 'status-followup') {
      await handleStatusFollowup(event);
    } else {
      await handleCostFollowup(event);
    }
    return;
  }

  const headers = event.headers ?? {};
  const signature = headers['x-signature-ed25519'] ?? headers['X-Signature-Ed25519'];
  const timestamp = headers['x-signature-timestamp'] ?? headers['X-Signature-Timestamp'];
  const rawBody = event.body ?? '';

  if (!verifyDiscordSignature(signature, timestamp, rawBody, DISCORD_PUBLIC_KEY)) {
    return { statusCode: 401, body: 'invalid request signature' };
  }

  const interaction = JSON.parse(rawBody);

  if (interaction.type === DISCORD_PING) {
    return jsonResponse({ type: 1 });
  }

  if (interaction.type !== DISCORD_APPLICATION_COMMAND) {
    return { statusCode: 400, body: 'unhandled interaction type' };
  }

  const applicationId: string = interaction.application_id;
  const interactionToken: string = interaction.token;
  const commandName: string = interaction.data?.name;

  switch (commandName) {
    case 'start':
      await invokeAsync(WAKE_FUNCTION_NAME, { applicationId, interactionToken });
      return jsonResponse(deferredResponse());
    case 'stop':
      await invokeAsync(STOP_FUNCTION_NAME, { applicationId, interactionToken });
      return jsonResponse(deferredResponse());
    case 'status': {
      const task: FollowupTask = { task: 'status-followup', applicationId, interactionToken };
      await invokeAsync(context.functionName, task);
      return jsonResponse(deferredResponse());
    }
    case 'cost': {
      const task: FollowupTask = { task: 'cost-followup', applicationId, interactionToken };
      await invokeAsync(context.functionName, task);
      return jsonResponse(deferredResponse());
    }
    default:
      return jsonResponse(messageResponse(`Unknown command: ${commandName}`));
  }
}

async function invokeAsync(functionName: string, payload: unknown): Promise<void> {
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
}

async function handleStatusFollowup(task: FollowupTask): Promise<void> {
  const { EC2Client, DescribeInstancesCommand } = await import('@aws-sdk/client-ec2');
  const ec2 = new EC2Client({});
  const described = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
  const state = described.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? 'unknown';

  let content: string;
  if (state === 'running') {
    const players = await queryPlayerCount();
    const connect = CONNECT_HOSTNAME ? ` Connect at ${CONNECT_HOSTNAME}:25565` : '';
    content =
      players === undefined
        ? "🟢 Running, but couldn't confirm Minecraft's readiness just now (it may still be starting)."
        : `🟢 Running — ${players}/${MAX_PLAYERS} players online.${connect}`;
  } else if (state === 'pending') {
    content = '⏳ Starting…';
  } else if (state === 'stopping' || state === 'shutting-down') {
    content = `Server is ${state}.`;
  } else {
    content = '🔴 Stopped.';
  }

  await postInteractionFollowup(task.applicationId, task.interactionToken, content);
}

async function handleCostFollowup(task: FollowupTask): Promise<void> {
  const { CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand } = await import(
    '@aws-sdk/client-cost-explorer'
  );
  const ce = new CostExplorerClient({});

  const today = new Date();
  const firstOfMonth = `${today.getUTCFullYear()}-${pad(today.getUTCMonth() + 1)}-01`;
  const todayStr = toDateString(today);
  const firstOfNextMonth = toDateString(
    new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1)),
  );

  let monthToDate = 0;
  let forecastRemaining = 0;

  try {
    if (todayStr !== firstOfMonth) {
      const actual = await ce.send(
        new GetCostAndUsageCommand({
          TimePeriod: { Start: firstOfMonth, End: todayStr },
          Granularity: 'MONTHLY',
          Metrics: ['UnblendedCost'],
        }),
      );
      monthToDate = Number(actual.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount ?? '0');
    }
  } catch (err) {
    console.error('GetCostAndUsage failed', err);
  }

  try {
    const forecast = await ce.send(
      new GetCostForecastCommand({
        TimePeriod: { Start: todayStr, End: firstOfNextMonth },
        Metric: 'UNBLENDED_COST',
        Granularity: 'MONTHLY',
      }),
    );
    forecastRemaining = Number(forecast.Total?.Amount ?? '0');
  } catch (err) {
    console.error('GetCostForecast failed (often unavailable with <4 days of history)', err);
  }

  const projected = monthToDate + forecastRemaining;
  const content =
    `💰 This month so far: $${monthToDate.toFixed(2)}. ` +
    (forecastRemaining > 0 || monthToDate > 0
      ? `Projected total by month end: ~$${projected.toFixed(2)}.`
      : "Projected total isn't available yet (needs a few days of billing history).");

  await postInteractionFollowup(task.applicationId, task.interactionToken, content);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function toDateString(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

async function queryPlayerCount(): Promise<number | undefined> {
  const { runRemoteCommand } = await import('../shared/ssm-run.js');
  const { status, stdout } = await runRemoteCommand(
    INSTANCE_ID,
    [
      'source /etc/mc-ondemand.env',
      'TOKEN=$(curl -s -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http://169.254.169.254/latest/api/token)',
      'REGION=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)',
      'PASSWORD=$(aws ssm get-parameter --name "$RCON_PARAM_NAME" --with-decryption --query Parameter.Value --output text --region "$REGION")',
      'mcrcon -H 127.0.0.1 -P "$RCON_PORT" -p "$PASSWORD" list',
    ].join(' && '),
    20_000,
  );
  if (status !== 'Success') return undefined;
  const match = stdout.match(/There are (\d+)/);
  return match ? Number(match[1]) : undefined;
}

function jsonResponse(body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}
