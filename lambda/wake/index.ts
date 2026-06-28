import { EC2Client, DescribeInstancesCommand, StartInstancesCommand } from '@aws-sdk/client-ec2';
import { postInteractionFollowup } from '../shared/discord';

const ec2 = new EC2Client({});
const INSTANCE_ID = process.env.INSTANCE_ID!;

export interface WakeEvent {
  readonly applicationId?: string;
  readonly interactionToken?: string;
}

export interface WakeResult {
  readonly ok: boolean;
  readonly state: string;
  readonly message: string;
}

export async function handler(event: WakeEvent = {}): Promise<WakeResult> {
  const described = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
  const state = described.Reservations?.[0]?.Instances?.[0]?.State?.Name;

  let result: WakeResult;
  switch (state) {
    case 'stopped':
      await ec2.send(new StartInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
      result = { ok: true, state: 'starting', message: '⏳ Instance launching… this takes 3-5 minutes. I\'ll post here when it\'s ready.' };
      break;
    case 'pending':
      result = { ok: true, state: 'starting', message: '⏳ Already starting…' };
      break;
    case 'running':
      result = { ok: true, state: 'running', message: '🟢 Already running.' };
      break;
    case 'stopping':
    case 'shutting-down':
      result = { ok: false, state, message: `Instance is currently ${state}; try again in a moment.` };
      break;
    default:
      result = { ok: false, state: state ?? 'unknown', message: `Unexpected instance state: ${state ?? 'unknown'}` };
  }

  console.log('wake result', result);

  if (event.applicationId && event.interactionToken) {
    await postInteractionFollowup(event.applicationId, event.interactionToken, result.message);
  }

  return result;
}
