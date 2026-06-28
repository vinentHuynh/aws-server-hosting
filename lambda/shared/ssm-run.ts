import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});

const TERMINAL_STATUSES = new Set(['Pending', 'InProgress', 'Delayed']);

export interface RemoteCommandResult {
  readonly status: string;
  readonly stdout: string;
}

export async function runRemoteCommand(
  instanceId: string,
  shellCommand: string,
  timeoutMs = 30_000,
): Promise<RemoteCommandResult> {
  const sent = await ssm.send(
    new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: 'AWS-RunShellScript',
      Parameters: { commands: [shellCommand] },
      TimeoutSeconds: 60,
    }),
  );
  const commandId = sent.Command?.CommandId;
  if (!commandId) {
    return { status: 'NoCommandId', stdout: '' };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await ssm.send(
        new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }),
      );
      if (res.Status && !TERMINAL_STATUSES.has(res.Status)) {
        return { status: res.Status, stdout: res.StandardOutputContent ?? '' };
      }
    } catch {
      // Invocation not registered with SSM yet; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { status: 'TimedOut', stdout: '' };
}
