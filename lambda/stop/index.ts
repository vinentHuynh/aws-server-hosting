import { EC2Client, DescribeInstancesCommand, StopInstancesCommand } from '@aws-sdk/client-ec2';
import { postInteractionFollowup } from '../shared/discord';
import { runRemoteCommand } from '../shared/ssm-run';

const ec2 = new EC2Client({});
const INSTANCE_ID = process.env.INSTANCE_ID!;

export interface StopEvent {
  readonly applicationId?: string;
  readonly interactionToken?: string;
}

export interface StopResult {
  readonly ok: boolean;
  readonly state: string;
  readonly message: string;
}

export async function handler(event: StopEvent = {}): Promise<StopResult> {
  const described = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
  const state = described.Reservations?.[0]?.Instances?.[0]?.State?.Name;

  let result: StopResult;

  if (state === 'stopped' || state === 'stopping') {
    result = { ok: true, state, message: `Server is already ${state}.` };
  } else if (state !== 'running') {
    result = { ok: false, state: state ?? 'unknown', message: `Cannot stop from state: ${state ?? 'unknown'}` };
  } else {
    const { status } = await runRemoteCommand(INSTANCE_ID, '/usr/local/bin/mc-manual-stop.sh', 90_000);

    if (status === 'Success') {
      await ec2.send(new StopInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
      result = { ok: true, state: 'stopping', message: '🛑 Server stopped.' };
    } else {
      result = {
        ok: false,
        state: 'running',
        message: `Graceful shutdown did not confirm (status: ${status}); instance left running. Try again.`,
      };
    }
  }

  console.log('stop result', result);

  if (event.applicationId && event.interactionToken) {
    await postInteractionFollowup(event.applicationId, event.interactionToken, result.message);
  }

  return result;
}
